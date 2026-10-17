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
  if (opts.platform === "win32") return new WindowsDpapiStore(opts.secretsDir, opts.run);
  return new SecretToolStore(opts.run);
}
