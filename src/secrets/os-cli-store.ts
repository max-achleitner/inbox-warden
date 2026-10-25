import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SecretKey, SecretStore } from "./store.js";
import { KEYCHAIN_SERVICE, SecretStoreUnavailableError, keychainAccount } from "./keyring-store.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with an argument array (never through a shell); `input` goes to stdin. */
export type RunCommand = (command: string, args: string[], input?: string) => Promise<CommandResult>;

export const runCommand: RunCommand = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.on("error", () => {}); // the program may exit before reading stdin
    child.stdin.end(input ?? "");
  });

function unavailable(what: string, result: CommandResult): SecretStoreUnavailableError {
  return new SecretStoreUnavailableError(`${what} failed: ${(result.stderr || result.stdout).trim().slice(0, 200) || `exit code ${result.code}`}`);
}

const SECURITY = "/usr/bin/security";
const SECURITY_NOT_FOUND = 44;

/**
 * The `password:` line of `security find-generic-password -g` (stderr): printable ASCII without
 * backslash is printed as `"text"`, anything else as `0x<HEX>  "<escaped>"`. (`-w` prints such
 * values as bare hex, which cannot be told apart from a password that consists of hex digits.)
 */
export function parseSecurityPassword(output: string): string | null {
  const value = /^password: ?(.*)$/m.exec(output)?.[1];
  if (value === undefined) return null;
  const hex = /^0x([0-9A-Fa-f]*)/.exec(value);
  if (hex) return Buffer.from(hex[1], "hex").toString("utf8");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value === "" ? "" : null;
}

/**
 * macOS login keychain via /usr/bin/security. The secret goes to `security -i` on stdin as hex
 * (`-X`), so it never appears in the process list. Same service/account as @napi-rs/keyring.
 */
export class MacSecurityStore implements SecretStore {
  constructor(private readonly run: RunCommand = runCommand) {}

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const result = await this.run(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(accountId, key), "-g"]);
    if (result.code === SECURITY_NOT_FOUND) return null;
    if (result.code !== 0) throw unavailable("Reading the macOS keychain", result);
    const value = parseSecurityPassword(result.stderr) ?? parseSecurityPassword(result.stdout);
    if (value === null) {
      throw new SecretStoreUnavailableError("Reading the macOS keychain failed: the output of /usr/bin/security was not understood.");
    }
    return value;
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    const account = keychainAccount(accountId, key);
    const hex = Buffer.from(value, "utf8").toString("hex");
    await this.run(SECURITY, ["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -X ${hex}\n`);
    // `security -i` keeps going after errors, so confirm by reading the value back.
    if ((await this.get(accountId, key)) !== value) {
      throw new SecretStoreUnavailableError("Saving to the macOS keychain failed (is the login keychain locked?)");
    }
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    const result = await this.run(SECURITY, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(accountId, key)]);
    if (result.code !== 0 && result.code !== SECURITY_NOT_FOUND) throw unavailable("Deleting from the macOS keychain", result);
  }
}

const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
// Both scripts exchange base64 on stdin/stdout, so no secret is ever on the command line and
// console code pages cannot mangle umlauts.
const PROTECT =
  "Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
  "$p = [Security.Cryptography.ProtectedData]::Protect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); " +
  "[Console]::Out.Write([Convert]::ToBase64String($p))";
const UNPROTECT =
  "Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
  "$p = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); " +
  "[Console]::Out.Write([Convert]::ToBase64String($p))";

/**
 * Windows: secrets encrypted with DPAPI (bound to the Windows user account) in
 * <CONFIG_DIR>/secrets/<accountId>.<key>.dpapi, file mode 0600.
 */
export class WindowsDpapiStore implements SecretStore {
  constructor(
    private readonly dir: string,
    private readonly run: RunCommand = runCommand,
    private readonly powershell: string = POWERSHELL,
  ) {}

  private file(accountId: string, key: SecretKey): string {
    return path.join(this.dir, `${accountId}.${key}.dpapi`);
  }

  private async powershellScript(script: string, input: string, what: string): Promise<string> {
    const result = await this.run(this.powershell, ["-NoProfile", "-NonInteractive", "-Command", script], input);
    if (result.code !== 0) throw unavailable(what, result);
    return result.stdout.trim();
  }

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    let blob: string;
    try {
      blob = await fs.readFile(this.file(accountId, key), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const plain = await this.powershellScript(UNPROTECT, blob, "Decrypting the stored secret");
    return Buffer.from(plain, "base64").toString("utf8");
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    const blob = await this.powershellScript(PROTECT, Buffer.from(value, "utf8").toString("base64"), "Encrypting the secret");
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file(accountId, key), blob, { mode: 0o600 });
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    await fs.rm(this.file(accountId, key), { force: true });
  }
}

// Generic credentials exactly as @napi-rs/keyring writes them on Windows: target "<account>.<service>",
// user name "<account>", the secret as UTF-16LE, Persist 3 (CRED_PERSIST_ENTERPRISE). Status codes:
// 0 done, 1168 not found, anything else a Win32 error.
const CREDENTIAL_TYPE = `
using System;
using System.Runtime.InteropServices;
public static class InboxWardenCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr credential);

  public static int Read(string target, out string blob) {
    blob = null;
    IntPtr found;
    if (!CredReadW(target, 1, 0, out found)) return Marshal.GetLastWin32Error();
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(found, typeof(CREDENTIAL));
      byte[] bytes = new byte[c.CredentialBlobSize];
      if (bytes.Length > 0) Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
      blob = Convert.ToBase64String(bytes);
      Array.Clear(bytes, 0, bytes.Length);
      return 0;
    } finally { CredFree(found); }
  }

  public static int Write(string target, string user, string blob) {
    byte[] bytes = Convert.FromBase64String(blob);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1;
    c.Persist = 3;
    c.TargetName = target;
    c.UserName = user;
    c.CredentialBlobSize = (uint)bytes.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(bytes.Length, 1));
    try {
      Marshal.Copy(bytes, 0, c.CredentialBlob, bytes.Length);
      return CredWriteW(ref c, 0) ? 0 : Marshal.GetLastWin32Error();
    } finally {
      for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(c.CredentialBlob, i, 0);
      Marshal.FreeHGlobal(c.CredentialBlob);
      Array.Clear(bytes, 0, bytes.Length);
    }
  }

  public static int Delete(string target) {
    return CredDeleteW(target, 1, 0) ? 0 : Marshal.GetLastWin32Error();
  }
}`;

/**
 * One script per operation; its stdin lines are the target (then user name and base64 blob for
 * writing). With redirected streams PowerShell writes its own errors as CLIXML, so every failure
 * (e.g. Add-Type refused in Constrained Language Mode) is caught and written as plain text.
 */
function credentialScript(call: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `Add-Type -TypeDefinition '${CREDENTIAL_TYPE}'`,
    "$l = @([Console]::In.ReadToEnd().Split([char]10) | ForEach-Object { $_.Trim() })",
    call,
    "} catch { [Console]::Error.Write($_.Exception.Message); exit 1 }",
    "if ($r -eq 0) { exit 0 }",
    "if ($r -eq 1168) { exit 3 }",
    "[Console]::Error.Write('Win32 error ' + $r)",
    "exit 1",
  ].join("\n");
}

const READ_CREDENTIAL = credentialScript(
  "$blob = $null; $r = [InboxWardenCredential]::Read($l[0], [ref]$blob); if ($r -eq 0) { [Console]::Out.Write($blob) }",
);
const WRITE_CREDENTIAL = credentialScript("$r = [InboxWardenCredential]::Write($l[0], $l[1], $l[2])");
const DELETE_CREDENTIAL = credentialScript("$r = [InboxWardenCredential]::Delete($l[0])");
const CREDENTIAL_NOT_FOUND = 3;
/** CRED_MAX_CREDENTIAL_BLOB_SIZE (5 × 512 bytes): 1,280 UTF-16 code units. */
const MAX_CREDENTIAL_BLOB_BYTES = 2560;

/**
 * Windows Credential Manager through PowerShell, for the MCPB bundle (no native modules): the same
 * entries @napi-rs/keyring reads and writes, so the bundle sees what `setup` stored. Secrets and
 * target names travel on stdin; the script goes as -EncodedCommand, which no argument quoting can
 * break. DPAPI files of older bundles are still read, and removed once the secret is written here.
 */
export class WindowsCredentialStore implements SecretStore {
  private readonly legacy: WindowsDpapiStore;

  constructor(
    secretsDir: string,
    private readonly run: RunCommand = runCommand,
    private readonly powershell: string = POWERSHELL,
  ) {
    this.legacy = new WindowsDpapiStore(secretsDir, run, powershell);
  }

  /** The finished command, or null when the credential does not exist. */
  private async credential(script: string, lines: string[], what: string): Promise<CommandResult | null> {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = await this.run(this.powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], `${lines.join("\n")}\n`);
    if (result.code === CREDENTIAL_NOT_FOUND) return null;
    if (result.code !== 0) throw unavailable(what, result);
    return result;
  }

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const found = await this.credential(READ_CREDENTIAL, [credentialTarget(accountId, key)], "Reading the Windows Credential Manager");
    if (found === null) return this.legacy.get(accountId, key);
    const blob = Buffer.from(found.stdout.trim(), "base64");
    if (blob.length % 2 !== 0) {
      throw new SecretStoreUnavailableError("Reading the Windows Credential Manager failed: the stored value is not UTF-16 text.");
    }
    return blob.toString("utf16le");
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    const blob = Buffer.from(value, "utf16le");
    if (blob.length > MAX_CREDENTIAL_BLOB_BYTES) {
      throw new SecretStoreUnavailableError(
        `the secret is longer than the Windows Credential Manager allows (${MAX_CREDENTIAL_BLOB_BYTES / 2} characters); nothing was saved`,
      );
    }
    const lines = [credentialTarget(accountId, key), keychainAccount(accountId, key), blob.toString("base64")];
    await this.credential(WRITE_CREDENTIAL, lines, "Saving to the Windows Credential Manager");
    await this.legacy.delete(accountId, key);
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    await this.credential(DELETE_CREDENTIAL, [credentialTarget(accountId, key)], "Deleting from the Windows Credential Manager");
    await this.legacy.delete(accountId, key);
  }
}

function credentialTarget(accountId: string, key: SecretKey): string {
  return `${keychainAccount(accountId, key)}.${KEYCHAIN_SERVICE}`;
}

/**
 * Linux Secret Service via `secret-tool` (package libsecret-tools). Attributes service/username
 * match @napi-rs/keyring, so both backends see the same entries. The secret goes in on stdin.
 */
export class SecretToolStore implements SecretStore {
  constructor(private readonly run: RunCommand = runCommand) {}

  private async secretTool(args: string[], input?: string): Promise<CommandResult> {
    try {
      return await this.run("secret-tool", args, input);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SecretStoreUnavailableError("secret-tool is not installed — install the package libsecret-tools (Debian/Ubuntu: sudo apt install libsecret-tools)");
      }
      throw err;
    }
  }

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const result = await this.secretTool(["lookup", "service", KEYCHAIN_SERVICE, "username", keychainAccount(accountId, key)]);
    if (result.code === 0) return result.stdout.replace(/\n$/, "");
    if (result.code === 1 && result.stderr.trim() === "") return null; // not found
    throw unavailable("Reading the Secret Service", result);
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    const account = keychainAccount(accountId, key);
    const result = await this.secretTool(["store", `--label=imap-mcp ${account}`, "service", KEYCHAIN_SERVICE, "username", account], value);
    if (result.code !== 0) throw unavailable("Saving to the Secret Service", result);
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    const result = await this.secretTool(["clear", "service", KEYCHAIN_SERVICE, "username", keychainAccount(accountId, key)]);
    if (result.code !== 0 && result.code !== 1) throw unavailable("Deleting from the Secret Service", result);
  }
}

export function createCliSecretStore(opts: { platform: NodeJS.Platform; secretsDir: string; run?: RunCommand }): SecretStore {
  if (opts.platform === "darwin") return new MacSecurityStore(opts.run);
  if (opts.platform === "win32") return new WindowsCredentialStore(opts.secretsDir, opts.run);
  return new SecretToolStore(opts.run);
}
