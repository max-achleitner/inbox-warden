import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SecretStoreUnavailableError } from "../keyring-store.js";
import { createKeychainStore } from "../keychain.js";
import {
  MacSecurityStore,
  SecretToolStore,
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
});
