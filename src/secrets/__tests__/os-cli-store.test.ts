import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KeyringSecretStore, SecretStoreUnavailableError } from "../keyring-store.js";
import { createKeychainStore } from "../keychain.js";
import {
  MacSecurityStore,
  SecretToolStore,
  WindowsCredentialStore,
  WindowsDpapiStore,
  runCommand,
  type CommandResult,
  type RunCommand,
} from "../os-cli-store.js";

interface Call {
  command: string;
  args: string[];
  input?: string;
}

/** Scripted child_process: each call pops the next result (or error) and is recorded. */
function scriptedRun(results: Array<Partial<CommandResult> | Error>): RunCommand & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (command: string, args: string[], input?: string) => {
    calls.push({ command, args, input });
    const next = results.shift() ?? { code: 0 };
    if (next instanceof Error) throw next;
    return { code: 0, stdout: "", stderr: "", ...next };
  }) as RunCommand & { calls: Call[] };
  run.calls = calls;
  return run;
}

const SECRET = "Pässwort 'mit' \"Quotes\" & $(rm -rf ~)";

/**
 * What `security find-generic-password -g` prints on stderr (Apple's print_buffer): printable ASCII
 * without backslash in quotes, anything else as 0x<HEX> plus an escaped rendering.
 */
function passwordLine(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const printable = [...bytes].every((b) => b >= 0x20 && b <= 0x7e && b !== 0x5c);
  return printable ? `password: "${value}"\n` : `password: 0x${bytes.toString("hex").toUpperCase()}  "escaped\\303"\n`;
}

describe("MacSecurityStore", () => {
  it("passes the secret only on stdin, hex-encoded, and verifies the write", async () => {
    const run = scriptedRun([{ code: 0 }, { code: 0, stderr: passwordLine(SECRET) }]);
    await new MacSecurityStore(run).set("main", "password", SECRET);
    expect(run.calls[0].command).toBe("/usr/bin/security");
    expect(run.calls[0].args).toEqual(["-i"]);
    expect(run.calls[0].input).toBe(`add-generic-password -U -s imap-mcp -a main:password -X ${Buffer.from(SECRET).toString("hex")}\n`);
    for (const call of run.calls) expect(call.args.join(" ")).not.toContain("Pässwort");
  });

  it("reads with find-generic-password -g and maps 'not found' (44) to null", async () => {
    const run = scriptedRun([{ code: 0, stderr: passwordLine("pw") }, { code: 44, stderr: "The specified item could not be found in the keychain." }]);
    const store = new MacSecurityStore(run);
    expect(await store.get("main", "password")).toBe("pw");
    expect(await store.get("main", "oauthRefreshToken")).toBeNull();
    expect(run.calls[0].args).toEqual(["find-generic-password", "-s", "imap-mcp", "-a", "main:password", "-g"]);
  });

  it.each([
    ["umlauts (printed as hex)", "Müller2026"],
    ["a backslash (printed as hex)", "a\\b"],
    ["a password that looks like hex", "00ff"],
    ["quotes", 'say "hi"'],
    ["an empty value", ""],
  ])("decodes %s exactly", async (_name, value) => {
    const run = scriptedRun([{ code: 0, stdout: 'keychain: "/Users/max/Library/Keychains/login.keychain-db"\n', stderr: passwordLine(value) }]);
    expect(await new MacSecurityStore(run).get("main", "password")).toBe(value);
  });

  it("fails loudly on output it cannot parse instead of returning a wrong secret", async () => {
    const run = scriptedRun([{ code: 0, stderr: "something unexpected\n" }]);
    await expect(new MacSecurityStore(run).get("main", "password")).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });

  it("reports a write that did not stick", async () => {
    const run = scriptedRun([{ code: 0 }, { code: 44 }]);
    await expect(new MacSecurityStore(run).set("main", "password", "x")).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });
});

describe("WindowsDpapiStore", () => {
  it("encrypts via PowerShell stdin and stores the blob in <id>.<key>.dpapi", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dpapi-"));
    const run = scriptedRun([{ code: 0, stdout: "QkxPQg==" }, { code: 0, stdout: Buffer.from(SECRET).toString("base64") }]);
    const store = new WindowsDpapiStore(dir, run, "powershell.exe");
    await store.set("main", "password", SECRET);
    expect(fs.readFileSync(path.join(dir, "main.password.dpapi"), "utf8")).toBe("QkxPQg==");
    expect(run.calls[0].args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(run.calls[0].args[3]).toContain("ProtectedData]::Protect");
    expect(run.calls[0].input).toBe(Buffer.from(SECRET).toString("base64"));
    for (const call of run.calls) expect(call.args.join(" ")).not.toContain(Buffer.from(SECRET).toString("base64"));

    expect(await store.get("main", "password")).toBe(SECRET);
    expect(run.calls[1].input).toBe("QkxPQg==");
    await store.delete("main", "password");
    expect(await store.get("main", "password")).toBeNull();
  });

  it.skipIf(process.platform !== "win32" || process.env.IMAP_MCP_KEYCHAIN_IT !== "1")("round-trips through real DPAPI", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dpapi-it-"));
    const store = new WindowsDpapiStore(dir, runCommand);
    await store.set("it", "password", SECRET);
    expect(fs.readFileSync(path.join(dir, "it.password.dpapi"), "utf8")).not.toContain("Pässwort");
    expect(await store.get("it", "password")).toBe(SECRET);
  }, 30_000);
});

describe("WindowsCredentialStore", () => {
  const utf16 = (value: string) => Buffer.from(value, "utf16le").toString("base64");
  const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "credman-"));
  /** The script of a call: passed as -EncodedCommand (UTF-16LE base64), so quotes in it survive Windows argument quoting. */
  const script = (call: Call) => Buffer.from(call.args[3], "base64").toString("utf16le");

  it("reads the generic credential <id>:<key>.imap-mcp via PowerShell and decodes UTF-16LE", async () => {
    const run = scriptedRun([{ code: 0, stdout: utf16(SECRET) }]);
    const store = new WindowsCredentialStore(tempDir(), run, "powershell.exe");
    expect(await store.get("main", "password")).toBe(SECRET);
    expect(run.calls[0].command).toBe("powershell.exe");
    expect(run.calls[0].args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(script(run.calls[0])).toContain("CredReadW");
    expect(run.calls[0].input?.split("\n")[0]).toBe("main:password.imap-mcp");
  });

  it("writes UTF-16LE with the target and user name @napi-rs/keyring uses, secret only on stdin", async () => {
    const run = scriptedRun([{ code: 0 }]);
    const store = new WindowsCredentialStore(tempDir(), run, "powershell.exe");
    await store.set("main", "password", SECRET);
    expect(run.calls).toHaveLength(1);
    expect(script(run.calls[0])).toContain("CredWriteW");
    expect(script(run.calls[0])).toContain("Persist = 3");
    expect(run.calls[0].input?.split("\n").slice(0, 3)).toEqual(["main:password.imap-mcp", "main:password", utf16(SECRET)]);
    const commandLine = run.calls[0].args.join(" ") + script(run.calls[0]);
    expect(commandLine).not.toContain(utf16(SECRET));
    expect(commandLine).not.toContain(SECRET);
  });

  it("maps 'not found' to null and falls back to a legacy DPAPI file", async () => {
    const dir = tempDir();
    expect(await new WindowsCredentialStore(dir, scriptedRun([{ code: 3 }]), "powershell.exe").get("main", "password")).toBeNull();

    fs.writeFileSync(path.join(dir, "main.password.dpapi"), "QkxPQg==");
    const run = scriptedRun([{ code: 3 }, { code: 0, stdout: Buffer.from(SECRET).toString("base64") }]);
    expect(await new WindowsCredentialStore(dir, run, "powershell.exe").get("main", "password")).toBe(SECRET);
    expect(run.calls[1].args[3]).toContain("ProtectedData]::Unprotect");
    expect(run.calls[1].input).toBe("QkxPQg==");
  });

  it("removes the legacy DPAPI file after writing and deletes both", async () => {
    const dir = tempDir();
    const legacy = path.join(dir, "main.password.dpapi");
    fs.writeFileSync(legacy, "QkxPQg==");
    const run = scriptedRun([{ code: 0 }, { code: 3 }]);
    const store = new WindowsCredentialStore(dir, run, "powershell.exe");
    await store.set("main", "password", SECRET);
    expect(fs.existsSync(legacy)).toBe(false);

    fs.writeFileSync(legacy, "QkxPQg==");
    await store.delete("main", "password");
    expect(script(run.calls[1])).toContain("CredDeleteW");
    expect(run.calls[1].input?.split("\n")[0]).toBe("main:password.imap-mcp");
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("refuses an odd-length blob and a secret over 1,280 UTF-16 units", async () => {
    const odd = new WindowsCredentialStore(tempDir(), scriptedRun([{ code: 0, stdout: Buffer.from([0x41]).toString("base64") }]), "powershell.exe");
    await expect(odd.get("main", "password")).rejects.toBeInstanceOf(SecretStoreUnavailableError);

    const run = scriptedRun([{ code: 0 }]);
    const store = new WindowsCredentialStore(tempDir(), run, "powershell.exe");
    await expect(store.set("main", "oauthRefreshToken", "x".repeat(1281))).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    expect(run.calls).toHaveLength(0);
    await store.set("main", "oauthRefreshToken", "x".repeat(1280));
    expect(run.calls).toHaveLength(1);
  });

  it("reports a blocked PowerShell without quoting the secret", async () => {
    const stderr = "Cannot invoke method. Method invocation is supported only on core types in this language mode.";
    const store = new WindowsCredentialStore(tempDir(), scriptedRun([{ code: 1, stderr }, { code: 1, stderr }]), "powershell.exe");
    await expect(store.get("main", "password")).rejects.toThrow(/language mode/);
    const failure = await store.set("main", "password", SECRET).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SecretStoreUnavailableError);
    expect((failure as Error).message).toContain("language mode");
    expect((failure as Error).message).not.toContain(SECRET);
    expect((failure as Error).message).not.toContain(utf16(SECRET));
  });

  it("writes PowerShell failures as plain text, not as CLIXML (redirected PowerShell serialises its error stream)", async () => {
    const run = scriptedRun([{ code: 3 }, { code: 0 }, { code: 0 }]);
    const store = new WindowsCredentialStore(tempDir(), run, "powershell.exe");
    await store.get("main", "password");
    await store.set("main", "password", "pw");
    await store.delete("main", "password");
    for (const call of run.calls) {
      expect(script(call)).toContain("$ProgressPreference = 'SilentlyContinue'");
      expect(script(call)).toMatch(/^try \{\n[\s\S]*\n\} catch \{ \[Console\]::Error\.Write\(\$_\.Exception\.Message\); exit 1 \}$/m);
    }
  });

  it("explains Constrained Language Mode (AppLocker, WDAC) instead of passing on PowerShell's noise", async () => {
    const run = scriptedRun([{ code: 4, stderr: "#< CLIXML <Objs …" }]);
    const failure = await new WindowsCredentialStore(tempDir(), run, "powershell.exe").get("main", "password").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SecretStoreUnavailableError);
    expect((failure as Error).message).toMatch(/Constrained Language Mode.*address and password.*command-line version/s);
    expect((failure as Error).message).not.toContain("CLIXML");
    expect(script(run.calls[0]).split("\n")[0]).toBe("if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { exit 4 }");
  });

  it.skipIf(process.platform !== "win32")("recognises a real Constrained Language Mode before touching the Credential Manager", async () => {
    // Runs the store's own script the way a locked-down machine would: decoded first, then executed in CLM.
    const constrained: RunCommand = (command, args, input) => {
      const original = Buffer.from(args[3], "base64").toString("utf16le");
      const wrapper =
        `$s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(original, "utf16le").toString("base64")}')); ` +
        "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; Invoke-Expression $s";
      return runCommand(command, [...args.slice(0, 3), Buffer.from(wrapper, "utf16le").toString("base64")], input);
    };
    const failure = await new WindowsCredentialStore(tempDir(), constrained).get(`iw-clm-${Date.now()}`, "password").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SecretStoreUnavailableError);
    expect((failure as Error).message).toContain("Constrained Language Mode");
  }, 30_000);

  it("reports a PowerShell that cannot be started as an unavailable credential store", async () => {
    const run = scriptedRun([Object.assign(new Error("spawn powershell.exe EACCES"), { code: "EACCES" })]);
    const failure = await new WindowsCredentialStore(tempDir(), run, "powershell.exe").get("main", "password").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SecretStoreUnavailableError);
    expect((failure as Error).message).toMatch(/PowerShell could not be started.*EACCES/);
  });

  it("writes in UTF-8, so umlauts in localised Windows messages survive", async () => {
    const run = scriptedRun([{ code: 3 }]);
    await new WindowsCredentialStore(tempDir(), run, "powershell.exe").get("main", "password");
    expect(script(run.calls[0])).toMatch(/^try \{\n\[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\)\n/m);
  });

  it.skipIf(process.platform !== "win32" || process.env.IMAP_MCP_KEYCHAIN_IT !== "1")(
    "shares entries with @napi-rs/keyring in both directions",
    async () => {
      const value = "Dümmy€😀 'q' \"x\"";
      const id = `iw-it-${Date.now()}`;
      const keyring = new KeyringSecretStore();
      const store = new WindowsCredentialStore(tempDir(), runCommand);
      try {
        await keyring.set(id, "password", value);
        expect(await store.get(id, "password")).toBe(value);
        await store.set(id, "oauthRefreshToken", value);
        expect(await keyring.get(id, "oauthRefreshToken")).toBe(value);
        await store.delete(id, "password");
        expect(await keyring.get(id, "password")).toBeNull();
      } finally {
        await keyring.delete(id, "password");
        await keyring.delete(id, "oauthRefreshToken");
      }
    },
    30_000,
  );
});

describe("SecretToolStore", () => {
  it("stores via stdin with the same attributes as @napi-rs/keyring", async () => {
    const run = scriptedRun([{ code: 0 }]);
    await new SecretToolStore(run).set("main", "password", SECRET);
    expect(run.calls[0]).toEqual({
      command: "secret-tool",
      args: ["store", "--label=imap-mcp main:password", "service", "imap-mcp", "username", "main:password"],
      input: SECRET,
    });
  });

  it("maps 'not found' to null and a missing secret-tool to an install hint", async () => {
    expect(await new SecretToolStore(scriptedRun([{ code: 1 }])).get("main", "password")).toBeNull();
    const missing = Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
    await expect(new SecretToolStore(scriptedRun([missing])).get("main", "password")).rejects.toThrow(/libsecret-tools/);
  });
});

describe("createKeychainStore", () => {
  it("uses the native keyring when it loads", async () => {
    const data = new Map<string, string>();
    const store = createKeychainStore({
      platform: "win32",
      secretsDir: "unused",
      loadKeyring: async () => (_service, account) => ({
        getPassword: async () => data.get(account) ?? null,
        setPassword: async (p: string) => void data.set(account, p),
        deleteCredential: async () => data.delete(account),
      }),
      run: scriptedRun([new Error("must not run")]),
    });
    await store.set("main", "password", "pw");
    expect(data.get("main:password")).toBe("pw");
  });

  it("falls back to the operating system tools when the native module is missing (MCPB bundle)", async () => {
    const run = scriptedRun([{ code: 0, stderr: passwordLine("from-security") }]);
    const store = createKeychainStore({
      platform: "darwin",
      secretsDir: "unused",
      loadKeyring: async () => {
        throw new SecretStoreUnavailableError("native module could not be loaded");
      },
      run,
    });
    expect(await store.get("main", "password")).toBe("from-security");
    expect(run.calls[0].command).toBe("/usr/bin/security");
  });

  it("reads the Windows Credential Manager, where the command-line version stores secrets, without the native module", async () => {
    const run = scriptedRun([{ code: 0, stdout: Buffer.from("from-credman", "utf16le").toString("base64") }]);
    const store = createKeychainStore({
      platform: "win32",
      secretsDir: fs.mkdtempSync(path.join(os.tmpdir(), "credman-")),
      loadKeyring: async () => {
        throw new SecretStoreUnavailableError("native module could not be loaded");
      },
      run,
    });
    expect(await store.get("main", "password")).toBe("from-credman");
    expect(Buffer.from(run.calls[0].args[3], "base64").toString("utf16le")).toContain("CredReadW");
  });
});
