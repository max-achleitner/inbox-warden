# Authentication, Credentials & Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every supported mailbox can be connected by a non-technical user — in one guided command or, for Claude Desktop bundle users, entirely from the chat — with secrets in the OS keychain (no native-build pain, no native modules required), OAuth2 sign-in for Microsoft 365 and Google Workspace, provider auto-detection, safe trust of self-signed certificates, a connection test before saving, and a `doctor` command that explains every problem in plain German or English.

**Architecture:** Secrets move from archived `keytar` to `@napi-rs/keyring`, with a native-module-free fallback (macOS `security`, Windows DPAPI via PowerShell, Linux `secret-tool`) and a one-time keytar migration, all behind the existing `SecretStore` contract. OAuth lives in `src/auth/oauth/` (PKCE loopback flow, Microsoft device-code fallback, token client, `OAuthAuthProvider implements AuthProvider`, `SignInManager` for the in-chat `sign_in` tool), so IMAP/SMTP code only asks the `AuthProvider` for credentials. Onboarding (`src/onboarding/`) is pure, dependency-injected logic — presets, autoconfig, certificate probe, connection test, diagnosis — driven by a thin CLI (`src/cli/`) whose whole dialogue is tested with a scripted prompter. Self-signed servers are supported by pinning exactly one certificate (sole trust anchor + SHA-256 check), never by switching verification off.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), `@napi-rs/keyring` 2.1, `@modelcontextprotocol/server` 2 (via Plan 2's `defineTool`), `imapflow` 2, `nodemailer` 10, zod 4, Node `http`/`tls`/`net`/`crypto`/`dns`/`child_process`, vitest, `selfsigned` (dev only, test certificates).

**Spec:** `docs/superpowers/specs/2026-10-14-production-readiness-design.md` (decisions D8, D9, D10; §3.4 provider facts; §9 contracts)

**Version:** ships as 0.5.0. Requires Plans 1 and 2 merged.

## Global Constraints

- Node `>=20.18.0` (engines set by Plan 2). ESM with `.js` import suffixes, 2-space indentation, double quotes — as in the existing code.
- zod 4 (`import { z } from "zod"`); the code below only uses APIs that behave the same in zod 3 and 4 (`z.object`, `.refine`, `.safeParse`, `z.coerce`, `z.string().url()`).
- Contracts from spec §9.1/§9.2 are consumed unchanged: `SecretStore`, `SecretKey`, `createSecretStore`, `AuthProvider`, `ImapAuth`, `SmtpAuth`, `createAuthProvider`, `AccountConfig`, `AccountSchema`, `AuthSchema`, `ConfigSchema`, `EndpointSchema`, `loadConfig`, `saveConfig`, `CONFIG_DIR`, `AppContext`, `defineTool`, `jsonResult`/`errorResult`, `FakeImap`, `createTestApp`.
- Plan 2 end state this plan edits (every edit below was applied to it and the full suite passed):
  - `src/secrets/store.ts`: `EnvSecretStore` (`IMAP_MCP_PASSWORD_<ID>[_FILE]`, `IMAP_MCP_OAUTH_REFRESH_TOKEN_<ID>[_FILE]`, for `main` also `IMAP_MCP_PASSWORD`/`IMAP_PASSWORD`), `ChainSecretStore`, `createSecretStore(env, { keychain? })` building `new KeytarSecretStore()`.
  - `src/secrets/keytar-store.ts`: `KeytarSecretStore` (service `imap-mcp`, account `<id>:<key>`) plus `readLegacyKeytarPassword`/`deleteLegacyKeytarPassword` (service `imap-mcp-server`, account = login), which `loadConfig`'s v1 → v2 migration imports.
  - `src/config/load.ts`: `configDir(env)`, `CONFIG_DIR`, `configFilePath(env)`, `configFromEnv(env)` (env-only account `main`), `migrateV1`, `saveConfig(config, env?)`, `loadConfig(env, { secrets })`.
  - `src/config/schema.ts`: `EndpointSchema` is a plain `z.object` with `tlsFingerprint256`; `ConfigSchema` is `z.object({…}).superRefine(…)` (duplicate ids, `defaultAccount`).
  - `src/auth/provider.ts`: `PasswordAuthProvider`; `createAuthProvider` throws for `oauth2` (tested in `src/auth/__tests__/provider.test.ts`).
  - `src/imap-client.ts`: `interface ImapEndpoint { host; port }`, `ImapConnectionManager(endpoint, auth, accountId)` calls `auth.imapAuth()` on every connect and after a rejected login `auth.invalidate()` plus exactly one retry.
  - `src/context.ts`: `smtpTransport(account, auth)` creates a nodemailer transport per message with `await auth.smtpAuth()`; `createAccountRuntime` passes `account.imap` to the connection manager; `createAppContext(config, secrets, deps)`; `AppContext` has no `secrets` yet.
  - `src/index.ts`: `createSecretStore()` → `loadConfig(process.env, { secrets })` → `createAppContext` → `serveStdio(() => createServer(app))`. Tools are listed in `ALL_TOOLS` (`src/tools/index.ts`); `src/__tests__/server.test.ts` asserts `ALL_TOOLS.length` tools, so appending a registration needs no test change.
  - `src/setup.ts`: minimal single-account wizard (replaced here). `createTestApp` (`src/__tests__/helpers/test-app.ts`) passes a fixed secret store whose `get` returns `"secret"`.
- New dependencies, exactly: `@napi-rs/keyring@^2.1.1` (dependency); `keytar` moves to **optionalDependencies** for this one release; `selfsigned@^5.5.0` (devDependency). Nothing else.
- Secrets never appear in `config.json`, logs, MCP stdout, error messages, command lines of child processes, or test snapshots. Child processes are spawned with argument arrays and `shell: false`; secrets go to their stdin.
- TLS verification is never disabled on a connection that carries credentials. The only `rejectUnauthorized: false` in the code base is `src/onboarding/cert-probe.ts`, which reads a certificate for display and sends nothing.
- No automatic retries of a rejected password; after an OAuth authentication failure exactly one retry with a fresh token (implemented by Plan 2's connection manager).
- Unit tests never use the network, a real keychain or a real browser. Real keychain round trips are opt-in: `IMAP_MCP_KEYCHAIN_IT=1`.
- All CLI text goes through `src/cli/messages.ts` in German and English (`IMAP_MCP_LANG` overrides the OS locale).
- The bin `imap-mcp-setup` stays (Plan 6 renames the package and bins).

## Review Focus

1. **No usable native keychain module** (MCPB bundle without native modules, Linux without an unlocked Secret Service). Expected: the operating system's own tools are used; if those are missing too, a plain-language `SecretStoreUnavailableError` names what to install — never a crash, never a silent fallback that forgets the password on reboot. → Task 1 test "pins Linux to the Secret Service", Task 2 tests "falls back to the operating system tools" and "a missing secret-tool to an install hint".
2. **Microsoft rotates the refresh token on every refresh.** Expected: the rotated token replaces the stored one, so the server still works after a restart. → Task 7 test "stores a rotated refresh token".
3. **Password typed or pasted in the hidden prompt** with umlauts, a trailing newline, Backspace, or Ctrl+C. Expected: exact value, stars only, Ctrl+C cancels without saving. → Task 11 tests.
4. **A pinned self-signed certificate is replaced on the server** (renewal or interception). Expected: connection refused with "the server presented a different certificate … run setup again", never silently accepted. → Task 6 test "fails with a plain-language error when the fingerprint does not match", Task 10 test "warns loudly about a changed pinned certificate".
5. **Bundle user on Microsoft 365 who never runs the CLI.** Expected: every mail tool answers "Not signed in yet — ask me to run sign_in"; `sign_in` opens the browser and returns the link without blocking longer than 45 s; a second `sign_in` call finishes. → Task 7 test "tells Claude to run sign_in", Task 8 tests "returns the sign-in link while waiting …".

---

### Task 1: Keyring secret store

**Files:**
- Create: `src/secrets/keyring-store.ts`
- Create: `src/secrets/memory-store.ts`
- Test: `src/secrets/__tests__/keyring-store.test.ts`
- Modify: `package.json` (dependency `@napi-rs/keyring`)

**Interfaces:**
- Consumes: `SecretKey`, `SecretStore` from `src/secrets/store.ts` (Plan 2); `errorMessage` from `src/errors.ts`.
- Produces:
  - `KEYCHAIN_SERVICE = "imap-mcp"`; `keychainAccount(accountId: string, key: SecretKey): string` → `"<id>:<key>"`
  - `interface KeyringEntry { getPassword(): Promise<string | null>; setPassword(p: string): Promise<void>; deleteCredential(): Promise<boolean> }`, `type KeyringEntryFactory = (service: string, account: string) => KeyringEntry`
  - `loadKeyringFactory(platform?: NodeJS.Platform, importer?: () => Promise<Pick<typeof import("@napi-rs/keyring"), "AsyncEntry">>): Promise<KeyringEntryFactory>`
  - `class KeyringSecretStore implements SecretStore { constructor(loadFactory?: () => Promise<KeyringEntryFactory>) }`
  - `class SecretStoreUnavailableError extends Error`
  - `class MemorySecretStore implements SecretStore { entries(): StoredSecret[] }`, `interface StoredSecret { accountId: string; key: SecretKey; value: string }`

- [ ] **Step 1: Add the dependency**

```bash
npm install @napi-rs/keyring@^2.1.1
```

Expected: `package.json` lists `"@napi-rs/keyring": "^2.1.1"` under `dependencies`; on Windows the prebuilt `@napi-rs/keyring-win32-x64-msvc` is installed (no build tools needed).

- [ ] **Step 2: Write the failing tests**

`src/secrets/__tests__/keyring-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  KEYCHAIN_SERVICE,
  KeyringSecretStore,
  loadKeyringFactory,
  SecretStoreUnavailableError,
  type KeyringEntryFactory,
} from "../keyring-store.js";

function fakeKeyring(): { factory: KeyringEntryFactory; data: Map<string, string>; failNext: () => void } {
  const data = new Map<string, string>();
  let fail = false;
  const factory: KeyringEntryFactory = (service, account) => {
    const key = `${service}|${account}`;
    const guard = () => {
      if (fail) {
        fail = false;
        throw new Error("Platform secure storage failure: keychain is locked");
      }
    };
    return {
      async getPassword() {
        guard();
        return data.get(key) ?? null;
      },
      async setPassword(password: string) {
        guard();
        data.set(key, password);
      },
      async deleteCredential() {
        guard();
        return data.delete(key);
      },
    };
  };
  return { factory, data, failNext: () => { fail = true; } };
}

describe("KeyringSecretStore", () => {
  it("stores secrets under service imap-mcp and account <id>:<key>", async () => {
    const kr = fakeKeyring();
    const store = new KeyringSecretStore(async () => kr.factory);
    await store.set("work", "password", "s3cret");
    expect(kr.data.get(`${KEYCHAIN_SERVICE}|work:password`)).toBe("s3cret");
    expect(await store.get("work", "password")).toBe("s3cret");
    expect(await store.get("work", "oauthRefreshToken")).toBeNull();
  });

  it("deletes secrets", async () => {
    const kr = fakeKeyring();
    const store = new KeyringSecretStore(async () => kr.factory);
    await store.set("work", "password", "x");
    await store.delete("work", "password");
    expect(await store.get("work", "password")).toBeNull();
  });

  it("maps a locked keychain to a plain-language SecretStoreUnavailableError", async () => {
    const kr = fakeKeyring();
    const store = new KeyringSecretStore(async () => kr.factory);
    kr.failNext();
    await expect(store.get("work", "password")).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });

  it("reports a missing native module as SecretStoreUnavailableError", async () => {
    const store = new KeyringSecretStore(async () => {
      throw new SecretStoreUnavailableError("native module could not be loaded: not found");
    });
    await expect(store.get("work", "password")).rejects.toThrow(/credential store could not be used/);
  });

  it("pins Linux to the Secret Service so secrets survive a reboot", async () => {
    const seen: unknown[] = [];
    class FakeAsyncEntry {
      constructor(_service: string, _account: string, options?: unknown) {
        seen.push(options);
      }
    }
    const importer = async () => ({ AsyncEntry: FakeAsyncEntry }) as never;
    (await loadKeyringFactory("linux", importer))("imap-mcp", "main:password");
    (await loadKeyringFactory("win32", importer))("imap-mcp", "main:password");
    expect(seen).toEqual([{ linux: { store: "secret-service" } }, undefined]);
  });

  it("turns a missing native binary into SecretStoreUnavailableError", async () => {
    await expect(
      loadKeyringFactory("linux", async () => {
        throw new Error("Cannot find native binding");
      }),
    ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });

  it.skipIf(process.env.IMAP_MCP_KEYCHAIN_IT !== "1")("round-trips through the real OS keychain", async () => {
    const store = new KeyringSecretStore();
    const id = `it-${Date.now()}`;
    await store.set(id, "password", "integration-secret");
    expect(await store.get(id, "password")).toBe("integration-secret");
    await store.delete(id, "password");
    expect(await store.get(id, "password")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/secrets/__tests__/keyring-store.test.ts`
Expected: FAIL — `Failed to resolve import "../keyring-store.js"`.

- [ ] **Step 4: Implement the store**

`src/secrets/keyring-store.ts`:

```ts
import { errorMessage } from "../errors.js";
import type { SecretKey, SecretStore } from "./store.js";

/** Service name under which every secret is stored in the OS credential store. */
export const KEYCHAIN_SERVICE = "imap-mcp";

/** The subset of @napi-rs/keyring's AsyncEntry this module uses (injectable for tests). */
export interface KeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

export class SecretStoreUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `The operating system's credential store could not be used (${detail}). ` +
        "On Linux, install and unlock a Secret Service keyring (for example gnome-keyring or KWallet); " +
        "in containers, pass secrets as environment variables instead.",
    );
    this.name = "SecretStoreUnavailableError";
  }
}

type KeyringModule = Pick<typeof import("@napi-rs/keyring"), "AsyncEntry">;

/** Load @napi-rs/keyring lazily so env-only deployments never touch the native module. */
export async function loadKeyringFactory(
  platform: NodeJS.Platform = process.platform,
  importer: () => Promise<KeyringModule> = () => import("@napi-rs/keyring"),
): Promise<KeyringEntryFactory> {
  let mod: KeyringModule;
  try {
    mod = await importer();
  } catch (err) {
    throw new SecretStoreUnavailableError(`native module could not be loaded: ${errorMessage(err)}`);
  }
  // Without this pin the library silently falls back to the kernel keyring, which forgets secrets on reboot.
  const options = platform === "linux" ? { linux: { store: "secret-service" as const } } : undefined;
  return (service, account) => new mod.AsyncEntry(service, account, options);
}

export function keychainAccount(accountId: string, key: SecretKey): string {
  return `${accountId}:${key}`;
}

export class KeyringSecretStore implements SecretStore {
  private factory?: Promise<KeyringEntryFactory>;

  constructor(private readonly loadFactory: () => Promise<KeyringEntryFactory> = () => loadKeyringFactory()) {}

  private async entry(accountId: string, key: SecretKey): Promise<KeyringEntry> {
    this.factory ??= this.loadFactory();
    const create = await this.factory;
    return create(KEYCHAIN_SERVICE, keychainAccount(accountId, key));
  }

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const entry = await this.entry(accountId, key);
    try {
      return (await entry.getPassword()) ?? null;
    } catch (err) {
      throw new SecretStoreUnavailableError(errorMessage(err));
    }
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    const entry = await this.entry(accountId, key);
    try {
      await entry.setPassword(value);
    } catch (err) {
      throw new SecretStoreUnavailableError(errorMessage(err));
    }
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    const entry = await this.entry(accountId, key);
    try {
      await entry.deleteCredential();
    } catch (err) {
      throw new SecretStoreUnavailableError(errorMessage(err));
    }
  }
}
```

`src/secrets/memory-store.ts` (stages credentials in the setup wizard; also used by tests):

```ts
import type { SecretKey, SecretStore } from "./store.js";

export interface StoredSecret {
  accountId: string;
  key: SecretKey;
  value: string;
}

/** In-memory SecretStore: stages credentials during setup until the user saves; also used by tests. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, StoredSecret>();

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    return this.values.get(`${accountId}:${key}`)?.value ?? null;
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    this.values.set(`${accountId}:${key}`, { accountId, key, value });
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    this.values.delete(`${accountId}:${key}`);
  }

  entries(): StoredSecret[] {
    return [...this.values.values()];
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/secrets/__tests__/keyring-store.test.ts`
Expected: PASS (6 passed, 1 skipped). On a desktop also run `IMAP_MCP_KEYCHAIN_IT=1 npx vitest run src/secrets/__tests__/keyring-store.test.ts` → 7 passed (creates and deletes one entry `it-<timestamp>:password`).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/secrets/keyring-store.ts src/secrets/memory-store.ts src/secrets/__tests__/keyring-store.test.ts
git commit -m "feat(secrets): add @napi-rs/keyring secret store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Keychain without native modules

The MCPB bundle (Plan 6) ships without native modules, and `@napi-rs/keyring` can fail to load on unusual systems. The operating system's own command-line tools then provide the same keychain.

**Files:**
- Create: `src/secrets/os-cli-store.ts`, `src/secrets/keychain.ts`
- Test: `src/secrets/__tests__/os-cli-store.test.ts`

**Interfaces:**
- Consumes: `KEYCHAIN_SERVICE`, `keychainAccount`, `SecretStoreUnavailableError`, `KeyringSecretStore`, `loadKeyringFactory`, `KeyringEntryFactory` (Task 1).
- Produces:
  - `interface CommandResult { code: number; stdout: string; stderr: string }`, `type RunCommand = (command: string, args: string[], input?: string) => Promise<CommandResult>`, `runCommand: RunCommand`
  - `class MacSecurityStore`, `class WindowsDpapiStore(dir, run?, powershell?)`, `class SecretToolStore` (all `implements SecretStore`)
  - `createCliSecretStore({ platform, secretsDir, run? }): SecretStore`
  - `interface KeychainOptions { platform?; secretsDir: string; loadKeyring?(); run? }`, `createKeychainStore(opts: KeychainOptions): SecretStore` (keyring → OS tools, chosen once)

- [ ] **Step 1: Write the failing tests**

`src/secrets/__tests__/os-cli-store.test.ts`:

```ts
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

describe("MacSecurityStore", () => {
  it("passes the secret only on stdin, hex-encoded, and verifies the write", async () => {
    const run = scriptedRun([{ code: 0 }, { code: 0, stdout: `${SECRET}\n` }]);
    await new MacSecurityStore(run).set("main", "password", SECRET);
    expect(run.calls[0].command).toBe("/usr/bin/security");
    expect(run.calls[0].args).toEqual(["-i"]);
    expect(run.calls[0].input).toBe(`add-generic-password -U -s imap-mcp -a main:password -X ${Buffer.from(SECRET).toString("hex")}\n`);
    for (const call of run.calls) expect(call.args.join(" ")).not.toContain("Pässwort");
  });

  it("reads with find-generic-password and maps 'not found' (44) to null", async () => {
    const run = scriptedRun([{ code: 0, stdout: "pw\n" }, { code: 44, stderr: "The specified item could not be found in the keychain." }]);
    const store = new MacSecurityStore(run);
    expect(await store.get("main", "password")).toBe("pw");
    expect(await store.get("main", "oauthRefreshToken")).toBeNull();
    expect(run.calls[0].args).toEqual(["find-generic-password", "-s", "imap-mcp", "-a", "main:password", "-w"]);
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
    const run = scriptedRun([{ code: 0, stdout: "from-security\n" }]);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/secrets/__tests__/os-cli-store.test.ts`
Expected: FAIL — `Failed to resolve import "../keychain.js"`.

- [ ] **Step 3: Implement**

`src/secrets/os-cli-store.ts`:

```ts
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
 * macOS login keychain via /usr/bin/security. The secret goes to `security -i` on stdin as hex
 * (`-X`), so it never appears in the process list. Same service/account as @napi-rs/keyring.
 */
export class MacSecurityStore implements SecretStore {
  constructor(private readonly run: RunCommand = runCommand) {}

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const result = await this.run(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(accountId, key), "-w"]);
    if (result.code === SECURITY_NOT_FOUND) return null;
    if (result.code !== 0) throw unavailable("Reading the macOS keychain", result);
    return result.stdout.replace(/\n$/, "");
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
```

`src/secrets/keychain.ts`:

```ts
import type { SecretKey, SecretStore } from "./store.js";
import { KeyringSecretStore, loadKeyringFactory, type KeyringEntryFactory } from "./keyring-store.js";
import { createCliSecretStore, type RunCommand } from "./os-cli-store.js";

export interface KeychainOptions {
  platform?: NodeJS.Platform;
  /** Directory for DPAPI files on Windows (CONFIG_DIR/secrets). */
  secretsDir: string;
  loadKeyring?(): Promise<KeyringEntryFactory>;
  run?: RunCommand;
}

/**
 * The OS keychain: @napi-rs/keyring when its native module loads; otherwise (MCPB bundles ship
 * without native modules) the operating system's own command-line tools. Chosen once, on first use.
 */
export function createKeychainStore(opts: KeychainOptions): SecretStore {
  const platform = opts.platform ?? process.platform;
  let selected: Promise<SecretStore> | undefined;
  const store = () =>
    (selected ??= (async () => {
      try {
        const factory = await (opts.loadKeyring ?? (() => loadKeyringFactory(platform)))();
        return new KeyringSecretStore(async () => factory);
      } catch {
        return createCliSecretStore({ platform, secretsDir: opts.secretsDir, run: opts.run });
      }
    })());
  return {
    get: async (accountId: string, key: SecretKey) => (await store()).get(accountId, key),
    set: async (accountId: string, key: SecretKey, value: string) => (await store()).set(accountId, key, value),
    delete: async (accountId: string, key: SecretKey) => (await store()).delete(accountId, key),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/secrets/__tests__/os-cli-store.test.ts`
Expected: PASS (8 passed, 1 skipped). On Windows also run `IMAP_MCP_KEYCHAIN_IT=1 npx vitest run src/secrets/__tests__/os-cli-store.test.ts` → 9 passed (real DPAPI round trip with umlauts and quotes, in a temporary directory).

- [ ] **Step 5: Manual check on macOS and Linux**

On a Mac: `node -e "import('./dist/secrets/os-cli-store.js').then(async m => { const s = new m.MacSecurityStore(); await s.set('it', 'password', 'Größe \"x\"'); console.log(await s.get('it', 'password')); await s.delete('it', 'password'); })"` after `npm run build` → prints `Größe "x"`; Keychain Access shows no leftover `imap-mcp` item. On Linux with `libsecret-tools`: the same with `SecretToolStore` → same output.

- [ ] **Step 6: Commit**

```bash
git add src/secrets/os-cli-store.ts src/secrets/keychain.ts src/secrets/__tests__/os-cli-store.test.ts
git commit -m "feat(secrets): keychain via OS tools when the native keyring is unavailable

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: One-time keytar migration and store wiring

**Files:**
- Create: `src/secrets/keytar-migration.ts`
- Test: `src/secrets/__tests__/keytar-migration.test.ts`
- Modify: `src/secrets/store.ts` (imports, keychain construction in `createSecretStore`)
- Modify: `src/config/load.ts` (import of the v0.1 helpers)
- Delete: `src/secrets/keytar-store.ts`
- Modify: `package.json` (keytar → optionalDependencies)

**Interfaces:**
- Consumes: `KEYCHAIN_SERVICE`, `keychainAccount`, `MemorySecretStore` (Task 1); `createKeychainStore` (Task 2); `configDir` (Plan 2).
- Produces:
  - `LEGACY_V01_SERVICE = "imap-mcp-server"`
  - `interface KeytarLocation { service: string; account: string }`, `keytarLocation(accountId, key): KeytarLocation` (Plan 2's names)
  - `interface KeytarReader { read(location): Promise<string | null>; remove(location): Promise<void> }`, `loadKeytarReader(): Promise<KeytarReader | null>`
  - `class MigratingSecretStore implements SecretStore { constructor(inner: SecretStore, loadReader: () => Promise<KeytarReader | null>) }`
  - `readLegacyKeytarPassword(user, loadReader?)`, `deleteLegacyKeytarPassword(user, loadReader?)` — moved from Plan 2's `keytar-store.ts`, same signatures for `loadConfig`
  - `createSecretStore(env?, opts?)` keeps Plan 2's signature; its keychain becomes `MigratingSecretStore(createKeychainStore(…), loadKeytarReader)`

- [ ] **Step 1: Write the failing tests**

`src/secrets/__tests__/keytar-migration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MemorySecretStore } from "../memory-store.js";
import {
  MigratingSecretStore,
  deleteLegacyKeytarPassword,
  keytarLocation,
  readLegacyKeytarPassword,
  type KeytarLocation,
  type KeytarReader,
} from "../keytar-migration.js";

function keytar(entries: Record<string, string>): KeytarReader & { removed: string[] } {
  const removed: string[] = [];
  const id = (l: KeytarLocation) => `${l.service}|${l.account}`;
  return {
    removed,
    async read(location) {
      return entries[id(location)] ?? null;
    },
    async remove(location) {
      removed.push(id(location));
      delete entries[id(location)];
    },
  };
}

describe("MigratingSecretStore", () => {
  it("uses the same names as Plan 2's KeytarSecretStore", () => {
    expect(keytarLocation("work", "oauthRefreshToken")).toEqual({ service: "imap-mcp", account: "work:oauthRefreshToken" });
  });

  it("moves a keytar secret into the keychain exactly once", async () => {
    const inner = new MemorySecretStore();
    const old = keytar({ "imap-mcp|work:password": "pw" });
    const store = new MigratingSecretStore(inner, async () => old);
    expect(await store.get("work", "password")).toBe("pw");
    expect(await inner.get("work", "password")).toBe("pw");
    expect(old.removed).toEqual(["imap-mcp|work:password"]);
    expect(await store.get("work", "password")).toBe("pw");
  });

  it("prefers the keychain over keytar entries", async () => {
    const inner = new MemorySecretStore();
    await inner.set("work", "password", "new");
    const old = keytar({ "imap-mcp|work:password": "old" });
    expect(await new MigratingSecretStore(inner, async () => old).get("work", "password")).toBe("new");
    expect(old.removed).toEqual([]);
  });

  it("returns null when keytar is not installed or fails", async () => {
    expect(await new MigratingSecretStore(new MemorySecretStore(), async () => null).get("main", "password")).toBeNull();
    const broken = new MigratingSecretStore(new MemorySecretStore(), async () => {
      throw new Error("keytar binary for this Node version missing");
    });
    expect(await broken.get("main", "password")).toBeNull();
  });
});

describe("v0.1 password helpers (used by loadConfig's v1 migration)", () => {
  it("read and delete the entry stored under the login", async () => {
    const old = keytar({ "imap-mcp-server|max@firma.example": "v01-pw" });
    expect(await readLegacyKeytarPassword("max@firma.example", async () => old)).toBe("v01-pw");
    await deleteLegacyKeytarPassword("max@firma.example", async () => old);
    expect(old.removed).toEqual(["imap-mcp-server|max@firma.example"]);
  });

  it("are harmless without keytar", async () => {
    expect(await readLegacyKeytarPassword("a@b.at", async () => null)).toBeNull();
    await expect(deleteLegacyKeytarPassword("a@b.at", async () => null)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/secrets/__tests__/keytar-migration.test.ts`
Expected: FAIL — `Failed to resolve import "../keytar-migration.js"`.

- [ ] **Step 3: Implement the migration**

`src/secrets/keytar-migration.ts`:

```ts
import type { SecretKey, SecretStore } from "./store.js";
import { KEYCHAIN_SERVICE, keychainAccount } from "./keyring-store.js";

/** Service name used by v0.1/v0.2, where the account was the login (email address). */
export const LEGACY_V01_SERVICE = "imap-mcp-server";

export interface KeytarLocation {
  service: string;
  account: string;
}

export interface KeytarReader {
  read(location: KeytarLocation): Promise<string | null>;
  remove(location: KeytarLocation): Promise<void>;
}

/**
 * keytar stays an optionalDependency for one release so existing secrets can be moved.
 * The specifier is a variable so TypeScript does not need keytar's types at build time.
 */
export async function loadKeytarReader(): Promise<KeytarReader | null> {
  const specifier = "keytar";
  let keytar: {
    getPassword(service: string, account: string): Promise<string | null>;
    deletePassword(service: string, account: string): Promise<boolean>;
  };
  try {
    const mod = await import(specifier);
    keytar = mod.default ?? mod;
  } catch {
    return null;
  }
  return {
    read: async (location) => (await keytar.getPassword(location.service, location.account)) ?? null,
    remove: async (location) => {
      await keytar.deletePassword(location.service, location.account);
    },
  };
}

/** Where v0.3/v0.4 (KeytarSecretStore) kept a secret — the same names the keyring uses now. */
export function keytarLocation(accountId: string, key: SecretKey): KeytarLocation {
  return { service: KEYCHAIN_SERVICE, account: keychainAccount(accountId, key) };
}

/**
 * Wraps the keychain. A secret missing there is looked up once in keytar's store, copied over and
 * deleted from keytar. @napi-rs/keyring cannot read entries written by keytar on Windows and Linux.
 */
export class MigratingSecretStore implements SecretStore {
  private reader?: Promise<KeytarReader | null>;

  constructor(
    private readonly inner: SecretStore,
    private readonly loadReader: () => Promise<KeytarReader | null>,
  ) {}

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const value = await this.inner.get(accountId, key);
    if (value !== null) return value;

    this.reader ??= this.loadReader().catch(() => null);
    const reader = await this.reader;
    if (!reader) return null;

    const location = keytarLocation(accountId, key);
    const secret = await reader.read(location).catch(() => null);
    if (!secret) return null;

    await this.inner.set(accountId, key, secret);
    try {
      await reader.remove(location);
    } catch {
      // The copy in the keychain is authoritative; a leftover keytar entry is harmless.
    }
    return secret;
  }

  set(accountId: string, key: SecretKey, value: string): Promise<void> {
    return this.inner.set(accountId, key, value);
  }

  delete(accountId: string, key: SecretKey): Promise<void> {
    return this.inner.delete(accountId, key);
  }
}

/** v1 → v2 config migration (loadConfig): the v0.1/v0.2 password stored under the login. */
export async function readLegacyKeytarPassword(
  user: string,
  loadReader: () => Promise<KeytarReader | null> = loadKeytarReader,
): Promise<string | null> {
  const reader = await loadReader().catch(() => null);
  if (!reader) return null;
  return reader.read({ service: LEGACY_V01_SERVICE, account: user }).catch(() => null);
}

export async function deleteLegacyKeytarPassword(
  user: string,
  loadReader: () => Promise<KeytarReader | null> = loadKeytarReader,
): Promise<void> {
  const reader = await loadReader().catch(() => null);
  await reader?.remove({ service: LEGACY_V01_SERVICE, account: user }).catch(() => {});
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/secrets/__tests__/keytar-migration.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the new keychain into `createSecretStore`**

In `src/secrets/store.ts` replace the first two lines

```ts
import { readFile } from "node:fs/promises";
import { KeytarSecretStore } from "./keytar-store.js";
```

with

```ts
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { configDir } from "../config/load.js";
import { createKeychainStore } from "./keychain.js";
import { MigratingSecretStore, loadKeytarReader } from "./keytar-migration.js";
```

and in `createSecretStore` replace

```ts
  const keychain = new KeytarSecretStore();
```

with

```ts
  // @napi-rs/keyring, or the OS tools when the native module is missing; keytar-era secrets move over once.
  const keychain = new MigratingSecretStore(createKeychainStore({ secretsDir: path.join(configDir(env), "secrets") }), loadKeytarReader);
```

(The env store stays first in the chain. `config/load.ts` imports only the *type* `SecretStore` from `store.ts`, so the new import creates no runtime cycle.)

In `src/config/load.ts` replace

```ts
import { deleteLegacyKeytarPassword, readLegacyKeytarPassword } from "../secrets/keytar-store.js";
```

with

```ts
import { deleteLegacyKeytarPassword, readLegacyKeytarPassword } from "../secrets/keytar-migration.js";
```

The v1 → v2 migration in `loadConfig` therefore keeps moving v0.1 passwords (it knows the login from the old file); `MigratingSecretStore` moves everything v0.3/v0.4 stored with keytar. Delete the keytar store:

```bash
git rm src/secrets/keytar-store.ts
```

- [ ] **Step 6: Make keytar optional for this release**

```bash
npm pkg delete dependencies.keytar
npm pkg set optionalDependencies.keytar="^7.9.0"
npm install
```

Expected: `package.json` has `keytar` only under `optionalDependencies`. (CI keeps installing `libsecret-1-dev` until Plan 6 drops keytar; if keytar fails to build, npm skips it and the migration reports "not installed".)

- [ ] **Step 7: Run the whole suite and the build**

Run: `npm run build && npm run typecheck && npm test`
Expected: build succeeds; all tests pass (Plan 2's `store.test.ts` and the v1 migration tests in `load.test.ts` unchanged).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/secrets src/config/load.ts
git commit -m "feat(secrets): migrate keytar secrets once; keychain = keyring or OS tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: OAuth core — PKCE, provider profiles, token client

**Files:**
- Create: `src/auth/oauth/errors.ts`, `src/auth/oauth/pkce.ts`, `src/auth/oauth/profiles.ts`, `src/auth/oauth/tokens.ts`
- Test: `src/auth/oauth/__tests__/oauth-core.test.ts`

**Interfaces:**
- Consumes: `AccountConfig` (Plan 2).
- Produces:
  - Errors: `OAuthConfigurationError`, `OAuthTokenError { code: string; description?: string }`, `OAuthSignInRequiredError { accountId }` ("Not signed in yet … ask me to run sign_in"), `OAuthReauthRequiredError { accountId }`, `OAuthAuthorizationError { code }`, `OAuthTimeoutError`
  - `challengeFor(verifier: string): string`, `createPkcePair(): { verifier: string; challenge: string }`, `randomState(): string`
  - `MICROSOFT_DEFAULT_CLIENT_ID: string | undefined` (owner decision O2), `MICROSOFT_SCOPES`, `GOOGLE_SCOPES`
  - `interface OAuthProfile { provider: "microsoft" | "google"; authorizeUrl; tokenUrl; deviceCodeUrl?; clientId; clientSecret?; scopes: string[]; redirectHost: "localhost" | "127.0.0.1"; extraAuthorizeParams: Record<string, string> }`, `interface OAuthSettings { clientId?; clientSecret?; tenant? }`
  - `microsoftProfile(s, defaultClientId?)`, `googleProfile(s)`, `profileFor(account: AccountConfig)`, `buildAuthorizeUrl(profile, { redirectUri, state, codeChallenge, loginHint? }): string`
  - `type FetchLike`, `interface TokenSet { accessToken; refreshToken?; expiresAt: number; scope? }`, `interface TokenDeps { fetch?; now?; timeoutMs? }`
  - `exchangeAuthorizationCode(profile, { code, verifier, redirectUri }, deps?)`, `refreshAccessToken(profile, refreshToken, deps?)`
  - `interface DeviceCodeGrant`, `requestDeviceCode(profile, deps?)`, `pollDeviceCode(profile, grant, deps & { sleep? })`

- [ ] **Step 1: Write the failing tests**

`src/auth/oauth/__tests__/oauth-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { challengeFor, createPkcePair, randomState } from "../pkce.js";
import { buildAuthorizeUrl, googleProfile, microsoftProfile } from "../profiles.js";
import { OAuthConfigurationError, OAuthTimeoutError, OAuthTokenError } from "../errors.js";
import {
  exchangeAuthorizationCode,
  pollDeviceCode,
  refreshAccessToken,
  requestDeviceCode,
  type FetchLike,
} from "../tokens.js";

/** Scripted token endpoint: each call pops the next [status, body] and records the request. */
function scriptedFetch(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; params: URLSearchParams }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, params: new URLSearchParams(init.body) });
    const [status, body] = responses.shift() ?? [500, {}];
    return { status, json: async () => body };
  };
  return { fetch, calls };
}

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates url-safe verifiers and states", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(challengeFor(verifier));
    expect(randomState()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("profiles", () => {
  it("builds the Microsoft profile for the organizations endpoint by default", () => {
    const p = microsoftProfile({ clientId: "11111111-2222-3333-4444-555555555555" });
    expect(p.tokenUrl).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
    expect(p.scopes).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(p.scopes).toContain("offline_access");
  });

  it("asks for a client id when none is configured", () => {
    expect(() => microsoftProfile({}, undefined)).toThrow(OAuthConfigurationError);
    expect(() => microsoftProfile({}, undefined)).toThrow(/client\) ID/);
  });

  it("rejects tenants that could alter the URL", () => {
    expect(() => microsoftProfile({ clientId: "x", tenant: "evil.com/../" })).toThrow(OAuthConfigurationError);
  });

  it("requires Google client id and secret", () => {
    expect(() => googleProfile({ clientId: "abc" })).toThrow(/client secret/);
  });

  it("puts PKCE, state and login hint into the authorize URL", () => {
    const p = googleProfile({ clientId: "cid", clientSecret: "sec" });
    const url = new URL(buildAuthorizeUrl(p, { redirectUri: "http://127.0.0.1:5000", state: "st", codeChallenge: "ch", loginHint: "a@b.c" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      response_type: "code",
      code_challenge: "ch",
      code_challenge_method: "S256",
      state: "st",
      access_type: "offline",
      prompt: "consent",
      login_hint: "a@b.c",
      scope: "https://mail.google.com/",
    });
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
});

describe("token endpoint client", () => {
  const ms = microsoftProfile({ clientId: "cid" });

  it("exchanges an authorization code with the PKCE verifier", async () => {
    const { fetch, calls } = scriptedFetch([[200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }]]);
    const tokens = await exchangeAuthorizationCode(ms, { code: "c0de", verifier: "v", redirectUri: "http://localhost:4000" }, { fetch, now: () => 1000 });
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1000 + 3_600_000, scope: undefined });
    expect(Object.fromEntries(calls[0].params)).toMatchObject({ grant_type: "authorization_code", code: "c0de", code_verifier: "v", client_id: "cid" });
    expect(calls[0].params.has("client_secret")).toBe(false);
  });

  it("sends the Google client secret on refresh", async () => {
    const google = googleProfile({ clientId: "cid", clientSecret: "sec" });
    const { fetch, calls } = scriptedFetch([[200, { access_token: "at2", expires_in: "3599" }]]);
    const tokens = await refreshAccessToken(google, "rt", { fetch, now: () => 0 });
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBeUndefined();
    expect(calls[0].params.get("client_secret")).toBe("sec");
  });

  it("surfaces RFC 6749 error codes", async () => {
    const { fetch } = scriptedFetch([[400, { error: "invalid_grant", error_description: "AADSTS70000: revoked" }]]);
    await expect(refreshAccessToken(ms, "rt", { fetch })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects malformed success answers", async () => {
    const { fetch } = scriptedFetch([[200, { token: "nope" }]]);
    await expect(refreshAccessToken(ms, "rt", { fetch })).rejects.toBeInstanceOf(OAuthTokenError);
  });
});

describe("device code flow (Microsoft fallback)", () => {
  const ms = microsoftProfile({ clientId: "cid" });

  it("polls through authorization_pending and slow_down", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      [200, { device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 }],
      [400, { error: "authorization_pending" }],
      [400, { error: "slow_down" }],
      [200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }],
    ]);
    const grant = await requestDeviceCode(ms, { fetch, now: () => clock });
    expect(grant.userCode).toBe("ABCD-EFGH");
    const tokens = await pollDeviceCode(ms, grant, {
      fetch,
      now: () => clock,
      sleep: async (msDelay) => {
        sleeps.push(msDelay);
        clock += msDelay;
      },
    });
    expect(tokens.refreshToken).toBe("rt");
    expect(sleeps).toEqual([5000, 5000, 10000]);
  });

  it("times out when the code expires", async () => {
    let clock = 0;
    const { fetch } = scriptedFetch([[400, { error: "authorization_pending" }], [400, { error: "expired_token" }]]);
    const grant = { deviceCode: "dc", userCode: "X", verificationUri: "https://microsoft.com/devicelogin", intervalMs: 1000, expiresAt: 60_000 };
    await expect(
      pollDeviceCode(ms, grant, { fetch, now: () => clock, sleep: async (d) => { clock += d; } }),
    ).rejects.toBeInstanceOf(OAuthTimeoutError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/auth/oauth/__tests__/oauth-core.test.ts`
Expected: FAIL — `Failed to resolve import "../pkce.js"`.

- [ ] **Step 3: Implement**

`src/auth/oauth/errors.ts`:

```ts
/** Misconfiguration the user or administrator must fix (missing client id, unknown tenant, …). */
export class OAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigurationError";
  }
}

/** Error answer from a token endpoint (RFC 6749 §5.2). */
export class OAuthTokenError extends Error {
  constructor(readonly code: string, readonly description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = "OAuthTokenError";
  }
}

/** No sign-in is stored yet for an OAuth account (typical right after installing the bundle). */
export class OAuthSignInRequiredError extends Error {
  constructor(readonly accountId: string) {
    super(`Not signed in yet to mail account "${accountId}" — ask me to run sign_in (or run "imap-mcp-setup").`);
    this.name = "OAuthSignInRequiredError";
  }
}

/** The stored sign-in can no longer be used; the user has to sign in again. */
export class OAuthReauthRequiredError extends Error {
  constructor(readonly accountId: string, reason: string) {
    super(
      `The sign-in for mail account "${accountId}" is no longer valid (${reason}). ` +
        `Ask me to run sign_in, or run "imap-mcp-setup" and choose "Sign in again".`,
    );
    this.name = "OAuthReauthRequiredError";
  }
}

/** The provider redirected back with an error (user cancelled, consent denied, …). */
export class OAuthAuthorizationError extends Error {
  constructor(readonly code: string, description?: string) {
    super(
      code === "access_denied"
        ? "Sign-in was cancelled or access was not granted."
        : `Sign-in failed (${code}${description ? `: ${description}` : ""}).`,
    );
    this.name = "OAuthAuthorizationError";
  }
}

export class OAuthTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out. Please start the sign-in again.`);
    this.name = "OAuthTimeoutError";
  }
}
```

`src/auth/oauth/pkce.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 S256 code challenge for a verifier. */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32)); // 43 characters, within RFC 7636's 43–128
  return { verifier, challenge: challengeFor(verifier) };
}

/** Unguessable value binding the redirect to this sign-in attempt (CSRF protection). */
export function randomState(): string {
  return base64url(randomBytes(24));
}
```

`src/auth/oauth/profiles.ts`:

```ts
import type { AccountConfig } from "../../config/schema.js";
import { OAuthConfigurationError } from "./errors.js";

/**
 * Owner decision O2: the "Application (client) ID" of the multi-tenant public client registered
 * for imap-mcp in Microsoft Entra ID. While undefined, every Microsoft account must set `auth.clientId`.
 */
export const MICROSOFT_DEFAULT_CLIENT_ID: string | undefined = undefined;

export const MICROSOFT_SCOPES = [
  "offline_access",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
];
export const GOOGLE_SCOPES = ["https://mail.google.com/"];

export interface OAuthProfile {
  provider: "microsoft" | "google";
  authorizeUrl: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Microsoft registers "http://localhost" (any port); Google desktop clients use 127.0.0.1. */
  redirectHost: "localhost" | "127.0.0.1";
  extraAuthorizeParams: Record<string, string>;
}

export interface OAuthSettings {
  clientId?: string;
  clientSecret?: string;
  tenant?: string;
}

export function microsoftProfile(settings: OAuthSettings, defaultClientId = MICROSOFT_DEFAULT_CLIENT_ID): OAuthProfile {
  const clientId = settings.clientId ?? defaultClientId;
  if (!clientId) {
    throw new OAuthConfigurationError(
      "No Microsoft application (client) ID is configured for this account. " +
        "Ask your Microsoft 365 administrator for the client ID of the app registration for imap-mcp " +
        "and enter it in setup (it is stored as auth.clientId).",
    );
  }
  const tenant = settings.tenant ?? "organizations";
  if (!/^[A-Za-z0-9.-]+$/.test(tenant)) {
    throw new OAuthConfigurationError(`"${tenant}" is not a valid Microsoft tenant (use a domain, a tenant ID, "organizations" or "consumers").`);
  }
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  return {
    provider: "microsoft",
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    deviceCodeUrl: `${base}/devicecode`,
    clientId,
    scopes: MICROSOFT_SCOPES,
    redirectHost: "localhost",
    extraAuthorizeParams: { prompt: "select_account" },
  };
}

export function googleProfile(settings: OAuthSettings): OAuthProfile {
  if (!settings.clientId || !settings.clientSecret) {
    throw new OAuthConfigurationError(
      "Google sign-in needs your organisation's own OAuth client (client ID and client secret of a " +
        '"Desktop app" client of an Internal consent screen in Google Cloud). See docs/guide/providers.md. ' +
        "Personal Gmail accounts should use an app password instead.",
    );
  }
  return {
    provider: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    scopes: GOOGLE_SCOPES,
    redirectHost: "127.0.0.1",
    // offline + consent: Google only returns a refresh token when both are requested
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  };
}

export function profileFor(account: AccountConfig): OAuthProfile {
  if (account.auth.type !== "oauth2") {
    throw new OAuthConfigurationError(`Account "${account.id}" does not use OAuth sign-in.`);
  }
  return account.auth.provider === "microsoft" ? microsoftProfile(account.auth) : googleProfile(account.auth);
}

export function buildAuthorizeUrl(
  profile: OAuthProfile,
  params: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(profile.authorizeUrl);
  const query: Record<string, string> = {
    client_id: profile.clientId,
    response_type: "code",
    redirect_uri: params.redirectUri,
    scope: profile.scopes.join(" "),
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    ...profile.extraAuthorizeParams,
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}
```

`src/auth/oauth/tokens.ts`:

```ts
import { z } from "zod";
import { OAuthAuthorizationError, OAuthConfigurationError, OAuthTimeoutError, OAuthTokenError } from "./errors.js";
import type { OAuthProfile } from "./profiles.js";

/** The subset of fetch() used here, injectable for tests. */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
}

export interface TokenDeps {
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive(),
  scope: z.string().optional(),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.coerce.number().positive(),
  interval: z.coerce.number().positive().optional(),
  message: z.string().optional(),
});

async function postForm(url: string, params: Record<string, string>, deps: TokenDeps): Promise<unknown> {
  const doFetch = deps.fetch ?? (fetch as unknown as FetchLike);
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const error = ErrorResponseSchema.safeParse(json);
  if (error.success) throw new OAuthTokenError(error.data.error, error.data.error_description);
  if (res.status >= 400) throw new OAuthTokenError("http_error", `The sign-in server answered HTTP ${res.status}.`);
  return json;
}

function toTokenSet(json: unknown, now: number): TokenSet {
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new OAuthTokenError("invalid_response", "The sign-in server returned an unexpected answer.");
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: now + parsed.data.expires_in * 1000,
    scope: parsed.data.scope,
  };
}

function clientParams(profile: OAuthProfile): Record<string, string> {
  return { client_id: profile.clientId, ...(profile.clientSecret ? { client_secret: profile.clientSecret } : {}) };
}

export async function exchangeAuthorizationCode(
  profile: OAuthProfile,
  input: { code: string; verifier: string; redirectUri: string },
  deps: TokenDeps = {},
): Promise<TokenSet> {
  const json = await postForm(
    profile.tokenUrl,
    {
      ...clientParams(profile),
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      scope: profile.scopes.join(" "),
    },
    deps,
  );
  return toTokenSet(json, (deps.now ?? Date.now)());
}

export async function refreshAccessToken(profile: OAuthProfile, refreshToken: string, deps: TokenDeps = {}): Promise<TokenSet> {
  const json = await postForm(
    profile.tokenUrl,
    { ...clientParams(profile), grant_type: "refresh_token", refresh_token: refreshToken, scope: profile.scopes.join(" ") },
    deps,
  );
  return toTokenSet(json, (deps.now ?? Date.now)());
}

export interface DeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  message?: string;
  intervalMs: number;
  expiresAt: number;
}

export async function requestDeviceCode(profile: OAuthProfile, deps: TokenDeps = {}): Promise<DeviceCodeGrant> {
  if (!profile.deviceCodeUrl) {
    throw new OAuthConfigurationError(`Sign-in with a code is not available for ${profile.provider}; use the browser sign-in.`);
  }
  const json = await postForm(profile.deviceCodeUrl, { client_id: profile.clientId, scope: profile.scopes.join(" ") }, deps);
  const parsed = DeviceCodeResponseSchema.safeParse(json);
  if (!parsed.success) throw new OAuthTokenError("invalid_response", "The sign-in server returned an unexpected answer.");
  const now = (deps.now ?? Date.now)();
  return {
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    message: parsed.data.message,
    intervalMs: (parsed.data.interval ?? 5) * 1000,
    expiresAt: now + parsed.data.expires_in * 1000,
  };
}

export async function pollDeviceCode(
  profile: OAuthProfile,
  grant: DeviceCodeGrant,
  deps: TokenDeps & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<TokenSet> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let interval = grant.intervalMs;
  while (now() < grant.expiresAt) {
    await sleep(interval);
    try {
      const json = await postForm(
        profile.tokenUrl,
        { client_id: profile.clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.deviceCode },
        deps,
      );
      return toTokenSet(json, now());
    } catch (err) {
      if (!(err instanceof OAuthTokenError)) throw err;
      if (err.code === "authorization_pending") continue;
      if (err.code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (err.code === "expired_token") break;
      if (err.code === "authorization_declined" || err.code === "access_denied") throw new OAuthAuthorizationError("access_denied");
      throw err;
    }
  }
  throw new OAuthTimeoutError("Sign-in with a code");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/auth/oauth/__tests__/oauth-core.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth
git commit -m "feat(auth): OAuth2 PKCE, Microsoft/Google profiles and token client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Interactive sign-in — loopback redirect, browser, device code

**Files:**
- Create: `src/auth/oauth/loopback.ts`, `src/auth/oauth/browser.ts`, `src/auth/oauth/flow.ts`
- Test: `src/auth/oauth/__tests__/flow.test.ts`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces:
  - `startLoopbackReceiver({ state, redirectHost, listenHost?, port?, timeoutMs?, language? }): Promise<LoopbackReceiver>` (listens on `listenHost ?? "127.0.0.1"`, `port ?? 0`; the redirect URI stays `http://<redirectHost>:<port>`), `interface LoopbackReceiver { redirectUri: string; waitForCode(): Promise<string>; close(): Promise<void> }`
  - `browserCommand(url, platform?): { command: string; args: string[] }`, `openBrowser(url, platform?): Promise<boolean>`
  - `interface InteractiveAuthOptions { print(line): void; language?; loginHint?; timeoutMs?; openBrowser?: ((url) => Promise<boolean>) | false; listenHost?: string; port?: number; onAuthorizeUrl?(url): void; tokenDeps? }` — `openBrowser: false` = print the link only (headless, containers)
  - `type AuthorizedTokens = TokenSet & { refreshToken: string }`
  - `runLoopbackAuthorization(profile, opts): Promise<AuthorizedTokens>`, `runDeviceCodeAuthorization(profile, opts): Promise<AuthorizedTokens>`

- [ ] **Step 1: Write the failing tests**

`src/auth/oauth/__tests__/flow.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { browserCommand, openBrowser } from "../browser.js";
import { OAuthAuthorizationError, OAuthTimeoutError } from "../errors.js";
import { runLoopbackAuthorization } from "../flow.js";
import { startLoopbackReceiver } from "../loopback.js";
import { googleProfile, microsoftProfile } from "../profiles.js";
import type { FetchLike } from "../tokens.js";

/** A port that was free a moment ago (for fixed-port tests). */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("loopback receiver", () => {
  it("listens on loopback and resolves the code for the matching state", async () => {
    const receiver = await startLoopbackReceiver({ state: "s1", redirectHost: "127.0.0.1", timeoutMs: 5000 });
    try {
      expect(receiver.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${receiver.redirectUri}/?code=abc&state=s1`);
      expect(res.status).toBe(200);
      expect(await receiver.waitForCode()).toBe("abc");
    } finally {
      await receiver.close();
    }
  });

  it("ignores redirects with a foreign state", async () => {
    const receiver = await startLoopbackReceiver({ state: "good", redirectHost: "127.0.0.1", timeoutMs: 5000 });
    try {
      const bad = await fetch(`${receiver.redirectUri}/?code=evil&state=bad`);
      expect(bad.status).toBe(400);
      await fetch(`${receiver.redirectUri}/?code=real&state=good`);
      expect(await receiver.waitForCode()).toBe("real");
    } finally {
      await receiver.close();
    }
  });

  it("rejects when the provider reports an error", async () => {
    const receiver = await startLoopbackReceiver({ state: "s", redirectHost: "127.0.0.1", timeoutMs: 5000 });
    try {
      await fetch(`${receiver.redirectUri}/?error=access_denied&state=s`);
      await expect(receiver.waitForCode()).rejects.toBeInstanceOf(OAuthAuthorizationError);
    } finally {
      await receiver.close();
    }
  });

  it("times out", async () => {
    const receiver = await startLoopbackReceiver({ state: "s", redirectHost: "127.0.0.1", timeoutMs: 50 });
    try {
      await expect(receiver.waitForCode()).rejects.toBeInstanceOf(OAuthTimeoutError);
    } finally {
      await receiver.close();
    }
  });

  it("honours listenHost and a fixed port (container: --listen-host 0.0.0.0 --port 53682)", async () => {
    const port = await freePort();
    const receiver = await startLoopbackReceiver({ state: "s", redirectHost: "localhost", listenHost: "0.0.0.0", port, timeoutMs: 5000 });
    try {
      // the redirect URI keeps the loopback name; the browser reaches the container through the published port
      expect(receiver.redirectUri).toBe(`http://localhost:${port}`);
      await fetch(`http://127.0.0.1:${port}/?code=c&state=s`);
      expect(await receiver.waitForCode()).toBe("c");
    } finally {
      await receiver.close();
    }
  });

  it("uses http://localhost:<port> for Microsoft", async () => {
    const receiver = await startLoopbackReceiver({ state: "s", redirectHost: "localhost", timeoutMs: 1000 });
    try {
      expect(receiver.redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
    } finally {
      await receiver.close();
    }
  });
});

describe("browser opening", () => {
  it("never uses a shell on Windows", () => {
    expect(browserCommand("https://x.test/?a=1&b=2", "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "https://x.test/?a=1&b=2"],
    });
    expect(browserCommand("https://x.test", "darwin").command).toBe("open");
    expect(browserCommand("https://x.test", "linux").command).toBe("xdg-open");
  });

  it("refuses non-https URLs", async () => {
    expect(await openBrowser("file:///etc/passwd")).toBe(false);
  });
});

describe("runLoopbackAuthorization", () => {
  it("drives the browser, receives the code and exchanges it with the verifier", async () => {
    const posted: URLSearchParams[] = [];
    const fetchToken: FetchLike = async (_url, init) => {
      posted.push(new URLSearchParams(init.body));
      return { status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600 }) };
    };
    const lines: string[] = [];
    const tokens = await runLoopbackAuthorization(googleProfile({ clientId: "cid", clientSecret: "sec" }), {
      print: (l) => lines.push(l),
      tokenDeps: { fetch: fetchToken },
      openBrowser: async (url) => {
        const u = new URL(url);
        const redirect = u.searchParams.get("redirect_uri")!;
        await fetch(`${redirect}/?code=the-code&state=${u.searchParams.get("state")}`);
        return true;
      },
    });
    expect(tokens.refreshToken).toBe("rt");
    expect(posted[0].get("code")).toBe("the-code");
    expect(posted[0].get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lines.some((l) => l.startsWith("https://accounts.google.com/"))).toBe(true);
  });

  it("with openBrowser: false only prints the link and listens where asked", async () => {
    const port = await freePort();
    const fetchToken: FetchLike = async () => ({ status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600 }) });
    const lines: string[] = [];
    const flow = runLoopbackAuthorization(microsoftProfile({ clientId: "cid" }), {
      print: (l) => lines.push(l),
      openBrowser: false,
      port,
      tokenDeps: { fetch: fetchToken },
      onAuthorizeUrl: (url) => {
        const u = new URL(url);
        expect(u.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}`);
        void fetch(`http://127.0.0.1:${port}/?code=c&state=${u.searchParams.get("state")}`);
      },
    });
    expect((await flow).refreshToken).toBe("rt");
    expect(lines.some((l) => l.includes("could not be opened"))).toBe(false);
  });

  it("fails clearly when no refresh token comes back", async () => {
    const fetchToken: FetchLike = async () => ({ status: 200, json: async () => ({ access_token: "at", expires_in: 3600 }) });
    await expect(
      runLoopbackAuthorization(microsoftProfile({ clientId: "cid" }), {
        print: () => {},
        tokenDeps: { fetch: fetchToken },
        openBrowser: async (url) => {
          const u = new URL(url);
          const port = new URL(u.searchParams.get("redirect_uri")!).port;
          await fetch(`http://127.0.0.1:${port}/?code=c&state=${u.searchParams.get("state")}`);
          return true;
        },
      }),
    ).rejects.toThrow(/refresh token/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/auth/oauth/__tests__/flow.test.ts`
Expected: FAIL — `Failed to resolve import "../browser.js"`.

- [ ] **Step 3: Implement**

`src/auth/oauth/loopback.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OAuthAuthorizationError, OAuthTimeoutError } from "./errors.js";

export interface LoopbackReceiver {
  /** The redirect_uri to send to the provider, e.g. "http://localhost:53123". */
  redirectUri: string;
  /** Resolves with the authorization code of the redirect whose `state` matches. */
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export interface LoopbackOptions {
  state: string;
  /** Host in the redirect URI the browser is sent to. */
  redirectHost: "localhost" | "127.0.0.1";
  /** Interface to listen on (default 127.0.0.1). "0.0.0.0" only inside a container whose port is published to the host loopback. */
  listenHost?: string;
  /** Fixed port (default: a random free port); needed when the port is published from a container. */
  port?: number;
  timeoutMs?: number;
  language?: "de" | "en";
}

const PAGES = {
  de: {
    ok: "Anmeldung erfolgreich. Sie können dieses Fenster schließen und zum Setup zurückkehren.",
    fail: "Die Anmeldung ist fehlgeschlagen. Sie können dieses Fenster schließen; Details stehen im Setup-Fenster.",
  },
  en: {
    ok: "Sign-in complete. You can close this window and return to the setup.",
    fail: "Sign-in failed. You can close this window; details are shown in the setup window.",
  },
};

function page(text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>imap-mcp</title></head><body style="font-family:sans-serif;margin:3em"><p>${text}</p></body></html>`;
}

/**
 * One-shot HTTP listener on the loopback interface for the OAuth redirect (RFC 8252 §7.3).
 * Requests with a wrong `state` are answered with 400 and ignored, so another local page
 * cannot inject a code into this sign-in.
 */
export async function startLoopbackReceiver(opts: LoopbackOptions): Promise<LoopbackReceiver> {
  const texts = PAGES[opts.language ?? "en"];
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {}); // rejection is observed through waitForCode()

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/" || (!url.searchParams.has("code") && !url.searchParams.has("error"))) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== opts.state) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid state");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(texts.fail));
      settle.reject(new OAuthAuthorizationError(error, url.searchParams.get("error_description") ?? undefined));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(texts.ok));
    settle.resolve(url.searchParams.get("code")!);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.listenHost ?? "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(() => settle.reject(new OAuthTimeoutError("Browser sign-in")), opts.timeoutMs ?? 5 * 60_000);
  timer.unref();

  return {
    redirectUri: `http://${opts.redirectHost}:${port}`,
    waitForCode: () => result,
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

`src/auth/oauth/browser.ts`:

```ts
import { spawn } from "node:child_process";

/**
 * Command that opens a URL in the default browser without going through a shell, so characters
 * such as "&" in the query string are never interpreted ("cmd /c start" would split at "&").
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** Opens only https URLs. Resolves false when no browser could be started (the caller prints the URL anyway). */
export async function openBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (new URL(url).protocol !== "https:") return false;
  const { command, args } = browserCommand(url, platform);
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true, shell: false });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
```

`src/auth/oauth/flow.ts`:

```ts
import { openBrowser as defaultOpenBrowser } from "./browser.js";
import { OAuthTokenError } from "./errors.js";
import { startLoopbackReceiver } from "./loopback.js";
import { createPkcePair, randomState } from "./pkce.js";
import { buildAuthorizeUrl, type OAuthProfile } from "./profiles.js";
import {
  exchangeAuthorizationCode,
  pollDeviceCode,
  requestDeviceCode,
  type TokenDeps,
  type TokenSet,
} from "./tokens.js";

export interface InteractiveAuthOptions {
  print(line: string): void;
  language?: "de" | "en";
  loginHint?: string;
  timeoutMs?: number;
  /** Opens the authorization URL; `false` = never try (headless/container), the URL is printed anyway. */
  openBrowser?: ((url: string) => Promise<boolean>) | false;
  /** Passed to the loopback receiver (see LoopbackOptions). */
  listenHost?: string;
  port?: number;
  /** Called with the authorization URL before the browser is opened (the sign_in tool returns it). */
  onAuthorizeUrl?(url: string): void;
  tokenDeps?: TokenDeps & { sleep?: (ms: number) => Promise<void> };
}

/** Sign-in result that is guaranteed to carry a refresh token. */
export type AuthorizedTokens = TokenSet & { refreshToken: string };

function requireRefreshToken(tokens: TokenSet, profile: OAuthProfile): AuthorizedTokens {
  if (!tokens.refreshToken) {
    throw new OAuthTokenError(
      "no_refresh_token",
      profile.provider === "google"
        ? "Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and sign in again."
        : "The sign-in server did not return a refresh token (offline_access missing).",
    );
  }
  return tokens as AuthorizedTokens;
}

/** Authorization code + PKCE with a loopback redirect (RFC 8252). */
export async function runLoopbackAuthorization(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens> {
  const de = opts.language === "de";
  const { verifier, challenge } = createPkcePair();
  const state = randomState();
  const receiver = await startLoopbackReceiver({
    state,
    redirectHost: profile.redirectHost,
    timeoutMs: opts.timeoutMs,
    language: opts.language,
    listenHost: opts.listenHost,
    port: opts.port,
  });
  try {
    const url = buildAuthorizeUrl(profile, {
      redirectUri: receiver.redirectUri,
      state,
      codeChallenge: challenge,
      loginHint: opts.loginHint,
    });
    opts.print(de ? "Bitte im Browser anmelden. Falls sich kein Fenster öffnet, diesen Link öffnen:" : "Please sign in in your browser. If no window opens, open this link:");
    opts.print(url);
    opts.onAuthorizeUrl?.(url);
    const opened = opts.openBrowser === false ? true : await (opts.openBrowser ?? defaultOpenBrowser)(url);
    if (!opened) opts.print(de ? "(Browser konnte nicht automatisch geöffnet werden.)" : "(The browser could not be opened automatically.)");
    const code = await receiver.waitForCode();
    const tokens = await exchangeAuthorizationCode(profile, { code, verifier, redirectUri: receiver.redirectUri }, opts.tokenDeps);
    return requireRefreshToken(tokens, profile);
  } finally {
    await receiver.close();
  }
}

/** Microsoft device code flow — fallback for machines without a usable browser. */
export async function runDeviceCodeAuthorization(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens> {
  const grant = await requestDeviceCode(profile, opts.tokenDeps);
  opts.print(
    opts.language === "de"
      ? `Öffnen Sie ${grant.verificationUri} und geben Sie den Code ${grant.userCode} ein.`
      : `Open ${grant.verificationUri} and enter the code ${grant.userCode}.`,
  );
  const tokens = await pollDeviceCode(profile, grant, opts.tokenDeps);
  return requireRefreshToken(tokens, profile);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/auth/oauth/__tests__/flow.test.ts`
Expected: PASS (11 tests). The tests talk to the receiver over real loopback HTTP; no external network.

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth
git commit -m "feat(auth): loopback PKCE sign-in, shell-free browser opening, device code fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Self-signed certificates — pinning and certificate probe

**Files:**
- Modify: `src/connection-security.ts` (full new content below; behaviour without a pin is unchanged from Plan 1)
- Modify: `src/config/schema.ts` (`EndpointSchema` field, `pinProblem`, `ConfigSchema.superRefine`)
- Create: `src/onboarding/cert-probe.ts`
- Create: `src/__tests__/helpers/tls-fixtures.ts`
- Test: `src/__tests__/tls-pinning.test.ts`, `src/config/__tests__/endpoint-pin.test.ts`, `src/onboarding/__tests__/cert-probe.test.ts`
- Modify: `src/imap-client.ts`, `src/context.ts` (pass the pin)
- Modify: `package.json` (devDependency `selfsigned`)

**Interfaces:**
- Consumes: Plan 1 `connection-security.ts` (`isLoopback`, `imapSecurityOptions`, `smtpSecurityOptions`).
- Produces:
  - `interface TlsPin { fingerprint256: string; certificatePem: string }`
  - `class CertificatePinMismatchError extends Error { code = "ERR_CERT_PIN_MISMATCH"; expected; actual }`
  - `certificateFingerprint256(pem)`, `pinFromEndpoint(endpoint): TlsPin | undefined`, `pinnedTlsOptions(pin): ConnectionOptions`
  - `imapSecurityOptions(host, port, pin?)`, `smtpSecurityOptions(host, port, pin?)` (new optional third parameter)
  - **Contract addition:** `EndpointSchema.tlsCertificatePem?: string` (EndpointSchema stays a plain, extendable `z.object`); `pinProblem(endpoint): string | undefined`; `ConfigSchema` rejects pins whose fingerprint and certificate are not set together or do not match.
  - `ImapEndpoint` (`src/imap-client.ts`) gains `tlsFingerprint256?`, `tlsCertificatePem?`
  - `interface ProbeOptions { host; port; protocol: "imap" | "smtp"; security: "implicit" | "starttls"; timeoutMs? }`, `interface CertificateInfo { pem; fingerprint256; subject; issuer; validFrom; validTo; selfSigned; trusted; trustError?; hostnameMatches }`, `class ProbeError`, `probeCertificate(opts): Promise<CertificateInfo>`
  - Test helpers: `selfSignedCert(cn?)`, `startTlsServer(cert, greeting?)`, `startStartTlsServer(cert, "imap" | "smtp", { offerStartTls? })`

- [ ] **Step 1: Add the dev dependency**

```bash
npm install --save-dev selfsigned@^5.5.0
```

- [ ] **Step 2: Write the test helpers and failing tests**

`src/__tests__/helpers/tls-fixtures.ts`:

```ts
import { X509Certificate } from "node:crypto";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { TLSSocket, createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import type { AddressInfo } from "node:net";
import { generate } from "selfsigned";

export interface SelfSignedCert {
  key: string;
  cert: string;
  fingerprint256: string;
}

/** Fresh self-signed certificate (EC P-256), the way a self-hosted mail server would have one. */
export async function selfSignedCert(commonName = "mail.selfhosted.test"): Promise<SelfSignedCert> {
  const pems = await generate([{ name: "commonName", value: commonName }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "subjectAltName", altNames: [{ type: 2, value: commonName }] },
    ],
  });
  return { key: pems.private, cert: pems.cert, fingerprint256: new X509Certificate(pems.cert).fingerprint256 };
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

function listen(server: NetServer | TlsServer, sockets: Set<Socket>): Promise<RunningServer> {
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

/** Implicit-TLS server that greets like an IMAP server. */
export function startTlsServer(cert: SelfSignedCert, greeting = "* OK test ready\r\n"): Promise<RunningServer> {
  const server = createTlsServer({ key: cert.key, cert: cert.cert }, (socket) => {
    socket.on("error", () => {});
    socket.write(greeting);
  });
  server.on("tlsClientError", () => {});
  return listen(server, new Set());
}

/** Plain server that upgrades to TLS after IMAP "STARTTLS" or SMTP "EHLO"/"STARTTLS". */
export function startStartTlsServer(cert: SelfSignedCert, protocol: "imap" | "smtp", opts: { offerStartTls?: boolean } = {}): Promise<RunningServer> {
  const offer = opts.offerStartTls ?? true;
  const server = createNetServer((socket) => {
    socket.on("error", () => {});
    socket.write(protocol === "imap" ? "* OK [CAPABILITY IMAP4rev1 STARTTLS] ready\r\n" : "220-mail.selfhosted.test ESMTP\r\n220 ready\r\n");
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      while (buffer.includes("\r\n")) {
        const line = buffer.slice(0, buffer.indexOf("\r\n"));
        buffer = buffer.slice(buffer.indexOf("\r\n") + 2);
        const upgrade = () => {
          socket.off("data", onData);
          const secure = new TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert });
          secure.on("error", () => {});
        };
        if (protocol === "imap" && /^a\d+ STARTTLS$/i.test(line)) {
          const tag = line.split(" ")[0];
          socket.write(offer ? `${tag} OK Begin TLS negotiation now\r\n` : `${tag} BAD STARTTLS not supported\r\n`);
          if (offer) upgrade();
        } else if (protocol === "smtp" && /^EHLO /i.test(line)) {
          socket.write(offer ? "250-mail.selfhosted.test\r\n250-PIPELINING\r\n250 STARTTLS\r\n" : "250-mail.selfhosted.test\r\n250 PIPELINING\r\n");
        } else if (protocol === "smtp" && /^STARTTLS$/i.test(line)) {
          socket.write("220 2.0.0 Ready to start TLS\r\n");
          upgrade();
        }
      }
    };
    socket.on("data", onData);
  });
  return listen(server, new Set());
}
```

`src/__tests__/tls-pinning.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect } from "node:tls";
import {
  CertificatePinMismatchError,
  certificateFingerprint256,
  imapSecurityOptions,
  pinFromEndpoint,
  pinnedTlsOptions,
  smtpSecurityOptions,
  type TlsPin,
} from "../connection-security.js";
import { selfSignedCert, startTlsServer, type RunningServer, type SelfSignedCert } from "./helpers/tls-fixtures.js";

function handshake(port: number, options: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, ...options }, () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });
}

describe("certificate pinning", () => {
  let cert: SelfSignedCert;
  let server: RunningServer;
  let pin: TlsPin;

  beforeAll(async () => {
    cert = await selfSignedCert();
    server = await startTlsServer(cert);
    pin = { fingerprint256: cert.fingerprint256, certificatePem: cert.cert };
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects the self-signed certificate without a pin", async () => {
    await expect(handshake(server.port, { minVersion: "TLSv1.2" })).rejects.toThrow(/self[- ]signed/i);
  });

  it("accepts it when pinned, even though the hostname (127.0.0.1) does not match", async () => {
    await expect(handshake(server.port, pinnedTlsOptions(pin))).resolves.toBeUndefined();
  });

  it("rejects a different certificate under the same pin", async () => {
    const other = await selfSignedCert();
    const otherServer = await startTlsServer(other);
    try {
      // the other cert is not the trust anchor, so the chain check already fails
      await expect(handshake(otherServer.port, pinnedTlsOptions(pin))).rejects.toThrow();
    } finally {
      await otherServer.close();
    }
  });

  it("fails with a plain-language error when the fingerprint does not match a trusted cert", async () => {
    const wrongPin = { fingerprint256: "00:" + cert.fingerprint256.slice(3), certificatePem: cert.cert };
    await expect(handshake(server.port, pinnedTlsOptions(wrongPin))).rejects.toBeInstanceOf(CertificatePinMismatchError);
  });

  it("computes fingerprints in Node's AB:CD:… format", () => {
    expect(certificateFingerprint256(cert.cert)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe("security options with a pin", () => {
  const pin: TlsPin = { fingerprint256: "AA", certificatePem: "-----BEGIN CERTIFICATE-----" };

  it("requires STARTTLS on loopback when a pin is set (Proton Mail Bridge)", () => {
    expect(imapSecurityOptions("127.0.0.1", 1143, pin)).toMatchObject({ secure: false, doSTARTTLS: true });
    expect(imapSecurityOptions("127.0.0.1", 1143).doSTARTTLS).toBeUndefined();
    expect(smtpSecurityOptions("127.0.0.1", 1025, pin).requireTLS).toBe(true);
  });

  it("adds the pin to the TLS options and keeps the TLS 1.2 floor", () => {
    const tls = imapSecurityOptions("mail.example.com", 993, pin).tls;
    expect(tls.minVersion).toBe("TLSv1.2");
    expect(tls.ca).toEqual([pin.certificatePem]);
    expect(typeof tls.checkServerIdentity).toBe("function");
  });

  it("builds a pin only when both fingerprint and certificate are configured", () => {
    expect(pinFromEndpoint({ tlsFingerprint256: "AA" })).toBeUndefined();
    expect(pinFromEndpoint({ tlsFingerprint256: "AA", tlsCertificatePem: "P" })).toEqual({ fingerprint256: "AA", certificatePem: "P" });
  });
});
```

`src/config/__tests__/endpoint-pin.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { ConfigSchema, EndpointSchema, pinProblem } from "../schema.js";
import { selfSignedCert, type SelfSignedCert } from "../../__tests__/helpers/tls-fixtures.js";

function config(imap: Record<string, unknown>) {
  return { version: 2, accounts: [{ id: "main", email: "max@firma.example", imap: { host: "mail.x", port: 993, ...imap } }] };
}

describe("certificate pin in the configuration", () => {
  let cert: SelfSignedCert;
  beforeAll(async () => {
    cert = await selfSignedCert();
  });

  it("accepts a matching fingerprint and certificate", () => {
    expect(ConfigSchema.safeParse(config({ tlsFingerprint256: cert.fingerprint256, tlsCertificatePem: cert.cert })).success).toBe(true);
  });

  it("rejects a fingerprint without certificate and vice versa", () => {
    expect(ConfigSchema.safeParse(config({ tlsFingerprint256: cert.fingerprint256 })).success).toBe(false);
    expect(ConfigSchema.safeParse(config({ tlsCertificatePem: cert.cert })).success).toBe(false);
  });

  it("rejects a fingerprint that does not belong to the certificate", async () => {
    const other = await selfSignedCert();
    const result = ConfigSchema.safeParse(config({ tlsFingerprint256: other.fingerprint256, tlsCertificatePem: cert.cert }));
    expect(result.success).toBe(false);
    expect(pinProblem({ tlsFingerprint256: other.fingerprint256, tlsCertificatePem: cert.cert })).toMatch(/does not match/);
  });

  it("keeps endpoints without a pin valid and EndpointSchema extendable", () => {
    expect(ConfigSchema.safeParse(config({})).success).toBe(true);
    expect(() => EndpointSchema.extend({ note: EndpointSchema.shape.host.optional() })).not.toThrow();
  });
});
```

`src/onboarding/__tests__/cert-probe.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { ProbeError, probeCertificate } from "../cert-probe.js";
import {
  selfSignedCert,
  startStartTlsServer,
  startTlsServer,
  type SelfSignedCert,
} from "../../__tests__/helpers/tls-fixtures.js";

describe("probeCertificate", () => {
  let cert: SelfSignedCert;

  beforeAll(async () => {
    cert = await selfSignedCert("mail.selfhosted.test");
  });

  it("reads the certificate of an implicit-TLS server and reports it as untrusted", async () => {
    const server = await startTlsServer(cert);
    try {
      const info = await probeCertificate({ host: "127.0.0.1", port: server.port, protocol: "imap", security: "implicit" });
      expect(info.fingerprint256).toBe(cert.fingerprint256);
      expect(info.pem).toContain("-----BEGIN CERTIFICATE-----");
      expect(info.subject).toContain("CN=mail.selfhosted.test");
      expect(info.selfSigned).toBe(true);
      expect(info.trusted).toBe(false);
      expect(info.trustError).toMatch(/SELF_SIGNED/);
      expect(info.hostnameMatches).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("upgrades an IMAP connection with STARTTLS", async () => {
    const server = await startStartTlsServer(cert, "imap");
    try {
      const info = await probeCertificate({ host: "127.0.0.1", port: server.port, protocol: "imap", security: "starttls" });
      expect(info.fingerprint256).toBe(cert.fingerprint256);
    } finally {
      await server.close();
    }
  });

  it("upgrades an SMTP connection with EHLO + STARTTLS", async () => {
    const server = await startStartTlsServer(cert, "smtp");
    try {
      const info = await probeCertificate({ host: "127.0.0.1", port: server.port, protocol: "smtp", security: "starttls" });
      expect(info.fingerprint256).toBe(cert.fingerprint256);
    } finally {
      await server.close();
    }
  });

  it("explains when the server offers no STARTTLS", async () => {
    const server = await startStartTlsServer(cert, "smtp", { offerStartTls: false });
    try {
      await expect(
        probeCertificate({ host: "127.0.0.1", port: server.port, protocol: "smtp", security: "starttls" }),
      ).rejects.toThrow(/does not offer STARTTLS/);
    } finally {
      await server.close();
    }
  });

  it("times out on a silent server", async () => {
    const { createServer } = await import("node:net");
    const silent = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as { port: number }).port;
    try {
      await expect(
        probeCertificate({ host: "127.0.0.1", port, protocol: "imap", security: "starttls", timeoutMs: 200 }),
      ).rejects.toBeInstanceOf(ProbeError);
    } finally {
      silent.close();
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/tls-pinning.test.ts src/config/__tests__/endpoint-pin.test.ts src/onboarding/__tests__/cert-probe.test.ts`
Expected: FAIL — `pinnedTlsOptions` / `CertificatePinMismatchError` not exported, `Failed to resolve import "../cert-probe.js"`, and `pinProblem` is not exported from the schema.

- [ ] **Step 4: Implement pinning**

Replace `src/connection-security.ts` with:

```ts
import { X509Certificate } from "node:crypto";
import type { ConnectionOptions, PeerCertificate } from "node:tls";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Local bridges (Proton Mail Bridge, DavMail) listen on loopback and may not offer STARTTLS. */
export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

const TLS_FLOOR: ConnectionOptions = { minVersion: "TLSv1.2" };

/** A self-signed server certificate the user explicitly chose to trust (spec D10). */
export interface TlsPin {
  /** "AB:CD:…" — the format of X509Certificate#fingerprint256 and PeerCertificate#fingerprint256. */
  fingerprint256: string;
  certificatePem: string;
}

export class CertificatePinMismatchError extends Error {
  readonly code = "ERR_CERT_PIN_MISMATCH";
  constructor(readonly expected: string, readonly actual: string) {
    super(
      `The mail server presented a different certificate than the one you trusted ` +
        `(expected ${expected}, got ${actual}). If you replaced the certificate on your server, run setup again to trust the new one; otherwise someone may be intercepting the connection.`,
    );
    this.name = "CertificatePinMismatchError";
  }
}

export function certificateFingerprint256(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

export function pinFromEndpoint(endpoint: { tlsFingerprint256?: string; tlsCertificatePem?: string }): TlsPin | undefined {
  if (!endpoint.tlsFingerprint256 || !endpoint.tlsCertificatePem) return undefined;
  return { fingerprint256: endpoint.tlsFingerprint256, certificatePem: endpoint.tlsCertificatePem };
}

/**
 * Trust exactly one certificate. Node calls checkServerIdentity only after the chain verified,
 * so the certificate itself is the only trust anchor (`ca`), and the fingerprint comparison
 * replaces the hostname check (self-signed certificates rarely carry the right name).
 * Verification is never switched off.
 */
export function pinnedTlsOptions(pin: TlsPin): ConnectionOptions {
  return {
    ca: [pin.certificatePem],
    checkServerIdentity: (_host: string, cert: PeerCertificate) =>
      cert.fingerprint256 === pin.fingerprint256 ? undefined : new CertificatePinMismatchError(pin.fingerprint256, cert.fingerprint256),
  };
}

/**
 * Implicit TLS on 993; on every other port STARTTLS is mandatory so a network attacker cannot
 * strip it and read the password. Loopback hosts keep imapflow's opportunistic default unless
 * a certificate is pinned (then TLS is required everywhere).
 */
export function imapSecurityOptions(
  host: string,
  port: number,
  pin?: TlsPin,
): { secure: boolean; doSTARTTLS?: true; tls: ConnectionOptions } {
  const secure = port === 993;
  const requireStartTls = !secure && (!isLoopback(host) || pin !== undefined);
  return {
    secure,
    ...(requireStartTls ? { doSTARTTLS: true as const } : {}),
    tls: { ...TLS_FLOOR, ...(pin ? pinnedTlsOptions(pin) : {}) },
  };
}

/** Implicit TLS on 465; STARTTLS required everywhere else except unpinned loopback. */
export function smtpSecurityOptions(
  host: string,
  port: number,
  pin?: TlsPin,
): { secure: boolean; requireTLS: boolean; tls: ConnectionOptions } {
  const secure = port === 465;
  return {
    secure,
    requireTLS: !secure && (!isLoopback(host) || pin !== undefined),
    tls: { ...TLS_FLOOR, ...(pin ? pinnedTlsOptions(pin) : {}) },
  };
}
```

In `src/config/schema.ts`:

1. Below `import { z } from "zod";` add

```ts
import { certificateFingerprint256 } from "../connection-security.js";
```

2. In `EndpointSchema`, after the `tlsFingerprint256` field, add the PEM field, and below the schema add `pinProblem` — the replaced block reads:

```ts
    .regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, "Use the colon-separated upper-case SHA-256 fingerprint")
    .optional(),
  /** PEM of the pinned certificate; set together with tlsFingerprint256 (checked in ConfigSchema). */
  tlsCertificatePem: z.string().startsWith("-----BEGIN CERTIFICATE-----").optional(),
});

/** Problem with a certificate pin, or undefined when the endpoint is consistent. */
export function pinProblem(endpoint: { tlsFingerprint256?: string; tlsCertificatePem?: string }): string | undefined {
  const { tlsFingerprint256: fingerprint, tlsCertificatePem: pem } = endpoint;
  if ((fingerprint === undefined) !== (pem === undefined)) return "tlsFingerprint256 and tlsCertificatePem must be set together";
  if (pem === undefined) return undefined;
  try {
    return certificateFingerprint256(pem) === fingerprint ? undefined : "tlsFingerprint256 does not match tlsCertificatePem";
  } catch {
    return "tlsCertificatePem is not a valid certificate";
  }
}
```

3. In `ConfigSchema`'s `superRefine`, replace

```ts
      seen.add(account.id);
    }
```

with

```ts
      seen.add(account.id);
      for (const endpoint of ["imap", "smtp"] as const) {
        const problem = account[endpoint] ? pinProblem(account[endpoint]) : undefined;
        if (problem) ctx.addIssue({ code: "custom", path: ["accounts", index, endpoint], message: problem });
      }
    }
```

The check lives in `ConfigSchema` (already refined) so `EndpointSchema` and `AccountSchema` stay plain objects that later plans can `.extend()`.

- [ ] **Step 5: Implement the certificate probe**

`src/onboarding/cert-probe.ts`:

```ts
import { X509Certificate } from "node:crypto";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface ProbeOptions {
  host: string;
  port: number;
  protocol: "imap" | "smtp";
  security: "implicit" | "starttls";
  timeoutMs?: number;
}

export interface CertificateInfo {
  pem: string;
  fingerprint256: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
  /** Whether the system trust store accepts the certificate for this host. */
  trusted: boolean;
  trustError?: string;
  hostnameMatches: boolean;
}

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

/** Read CRLF lines until `done(lines)` is true. */
function readLines(socket: Socket, done: (lines: string[]) => boolean): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const lines: string[] = [];
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (done(lines)) {
          cleanup();
          resolve(lines);
          return;
        }
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new ProbeError("The server closed the connection."));
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

const smtpFinal = (lines: string[]) => /^\d{3} /.test(lines[lines.length - 1] ?? "");

async function startTlsDialog(socket: Socket, protocol: "imap" | "smtp"): Promise<void> {
  if (protocol === "imap") {
    const greeting = await readLines(socket, (l) => l.length >= 1);
    if (!/^\* (OK|PREAUTH)/i.test(greeting[0])) throw new ProbeError(`Unexpected IMAP greeting: ${greeting[0].slice(0, 80)}`);
    socket.write("a1 STARTTLS\r\n");
    const answer = await readLines(socket, (l) => l.some((x) => x.startsWith("a1 ")));
    if (!/^a1 OK/i.test(answer[answer.length - 1])) throw new ProbeError("The IMAP server does not offer STARTTLS on this port.");
    return;
  }
  const greeting = await readLines(socket, smtpFinal);
  if (!greeting[greeting.length - 1].startsWith("220")) throw new ProbeError(`Unexpected SMTP greeting: ${greeting[0].slice(0, 80)}`);
  socket.write("EHLO imap-mcp-probe\r\n");
  const ehlo = await readLines(socket, smtpFinal);
  if (!ehlo.some((l) => /^250[ -]STARTTLS\b/i.test(l))) throw new ProbeError("The SMTP server does not offer STARTTLS on this port.");
  socket.write("STARTTLS\r\n");
  const ready = await readLines(socket, smtpFinal);
  if (!ready[ready.length - 1].startsWith("220")) throw new ProbeError("The SMTP server refused STARTTLS.");
}

function describe(socket: TLSSocket, host: string): CertificateInfo {
  const peer = socket.getPeerCertificate(true);
  if (!peer || !peer.raw) throw new ProbeError("The server did not present a certificate.");
  const x509 = new X509Certificate(peer.raw);
  return {
    pem: x509.toString(),
    fingerprint256: x509.fingerprint256,
    subject: x509.subject.replace(/\n/g, ", "),
    issuer: x509.issuer.replace(/\n/g, ", "),
    validFrom: new Date(x509.validFrom).toISOString(),
    validTo: new Date(x509.validTo).toISOString(),
    selfSigned: x509.checkIssued(x509),
    trusted: socket.authorized,
    trustError: socket.authorized ? undefined : String(socket.authorizationError),
    hostnameMatches: (isIP(host) ? x509.checkIP(host) : x509.checkHost(host)) !== undefined,
  };
}

/**
 * Fetch the server certificate so the user can decide whether to trust it. Verification is
 * deliberately not enforced here: this connection only reads the certificate (like
 * `openssl s_client`), sends no credentials and is closed immediately. Whether the system
 * trusts the certificate is reported in `trusted`/`trustError`.
 */
export async function probeCertificate(opts: ProbeOptions): Promise<CertificateInfo> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const servername = isIP(opts.host) ? undefined : opts.host;
  let plain: Socket | undefined;
  let secure: TLSSocket | undefined;

  const work = (async () => {
    if (opts.security === "starttls") {
      plain = netConnect({ host: opts.host, port: opts.port });
      await new Promise<void>((resolve, reject) => {
        plain!.once("connect", () => resolve());
        plain!.once("error", reject);
      });
      await startTlsDialog(plain, opts.protocol);
    }
    secure = tlsConnect({
      ...(plain ? { socket: plain } : { host: opts.host, port: opts.port }),
      servername,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    await new Promise<void>((resolve, reject) => {
      secure!.once("secureConnect", () => resolve());
      secure!.once("error", reject);
    });
    return describe(secure, opts.host);
  })();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeError(`No answer from ${opts.host}:${opts.port} within ${timeoutMs / 1000} s.`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    secure?.destroy();
    plain?.destroy();
  }
}
```

- [ ] **Step 6: Pass the pin where connections are made**

In `src/imap-client.ts`:

```ts
// import
import { imapSecurityOptions, pinFromEndpoint } from "./connection-security.js";

// interface (createAccountRuntime already passes account.imap, which now carries the pin)
export interface ImapEndpoint {
  host: string;
  port: number;
  tlsFingerprint256?: string;
  tlsCertificatePem?: string;
}

// in connectWithRetry(), the ImapFlow options line
          ...imapSecurityOptions(this.endpoint.host, this.endpoint.port, pinFromEndpoint(this.endpoint)),
```

In `src/context.ts`, change the import to `import { pinFromEndpoint, smtpSecurityOptions } from "./connection-security.js";` and in `smtpTransport()` the options line to

```ts
        ...smtpSecurityOptions(smtp.host, smtp.port, pinFromEndpoint(smtp)),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/tls-pinning.test.ts src/config/__tests__/endpoint-pin.test.ts src/onboarding/__tests__/cert-probe.test.ts src/__tests__/connection-security.test.ts && npm run build`
Expected: PASS (8 + 4 + 5 tests, plus Plan 1's 4 connection-security tests unchanged); build succeeds.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/connection-security.ts src/config/schema.ts src/onboarding/cert-probe.ts src/__tests__ src/config/__tests__ src/onboarding/__tests__/cert-probe.test.ts src/imap-client.ts src/context.ts
git commit -m "feat(tls): pin self-signed server certificates instead of disabling verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: OAuthAuthProvider, connection wiring and env-only OAuth

**Files:**
- Create: `src/auth/oauth/provider.ts`, `src/config/env-auth.ts`
- Test: `src/auth/oauth/__tests__/provider.test.ts`, `src/config/__tests__/env-auth.test.ts`
- Modify: `src/auth/provider.ts` (`createAuthProvider` oauth2 branch) and its Plan 2 test `src/auth/__tests__/provider.test.ts`
- Modify: `src/config/load.ts` (`configFromEnv` auth object)

**Interfaces:**
- Consumes: `AuthProvider`, `ImapAuth`, `SmtpAuth`, `SecretStore`, `AccountConfig`, `AccountSchema`, `AuthSchema` (Plan 2); `profileFor`, `refreshAccessToken`, OAuth errors (Task 4); `MemorySecretStore` (Task 1).
- Produces:
  - `EXPIRY_SKEW_MS = 120000`
  - `class OAuthAuthProvider implements AuthProvider { constructor(account, secrets, deps?: TokenDeps & { profile?: OAuthProfile }); readonly username: string; accessToken(): Promise<string> }`
  - `authFromEnv(env, username?): AccountConfig["auth"]` — **contract addition:** env-only mode reads `IMAP_MCP_AUTH` = `password` (default) | `microsoft` | `google`, `IMAP_MCP_OAUTH_CLIENT_ID`, `IMAP_MCP_OAUTH_CLIENT_SECRET` (Google only), `IMAP_MCP_OAUTH_TENANT` (Microsoft only)

- [ ] **Step 1: Write the failing tests**

`src/auth/oauth/__tests__/provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MemorySecretStore } from "../../../secrets/memory-store.js";
import { AccountSchema } from "../../../config/schema.js";
import { OAuthConfigurationError, OAuthReauthRequiredError, OAuthSignInRequiredError } from "../errors.js";
import { OAuthAuthProvider } from "../provider.js";
import type { FetchLike } from "../tokens.js";

const account = AccountSchema.parse({
  id: "work",
  email: "max@firma.at",
  imap: { host: "outlook.office365.com", port: 993 },
  smtp: { host: "smtp.office365.com", port: 587 },
  auth: { type: "oauth2", provider: "microsoft", clientId: "cid" },
});

function tokenEndpoint(responses: Array<[number, unknown]>) {
  let calls = 0;
  const fetch: FetchLike = async () => {
    calls++;
    const [status, body] = responses.shift() ?? [500, {}];
    return { status, json: async () => body };
  };
  return { fetch, calls: () => calls };
}

describe("OAuthAuthProvider", () => {
  it("refreshes once, caches the access token and stores a rotated refresh token", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt-1");
    const ep = tokenEndpoint([[200, { access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 }]]);
    let clock = 0;
    const provider = new OAuthAuthProvider(account, secrets, { fetch: ep.fetch, now: () => clock });

    expect(await provider.imapAuth()).toEqual({ user: "max@firma.at", accessToken: "at-1" });
    clock = 30 * 60_000;
    expect(await provider.smtpAuth()).toEqual({ type: "OAuth2", user: "max@firma.at", accessToken: "at-1" });
    expect(ep.calls()).toBe(1);
    expect(await secrets.get("work", "oauthRefreshToken")).toBe("rt-2");
  });

  it("refreshes before expiry and shares one refresh between concurrent callers", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt");
    const ep = tokenEndpoint([
      [200, { access_token: "a", expires_in: 3600 }],
      [200, { access_token: "b", expires_in: 3600 }],
    ]);
    let clock = 0;
    const provider = new OAuthAuthProvider(account, secrets, { fetch: ep.fetch, now: () => clock });
    const [x, y] = await Promise.all([provider.accessToken(), provider.accessToken()]);
    expect([x, y]).toEqual(["a", "a"]);
    clock = 3600_000 - 60_000; // inside the 2-minute skew
    expect(await provider.accessToken()).toBe("b");
    expect(ep.calls()).toBe(2);
  });

  it("asks the user to sign in again when the refresh token was revoked", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt");
    const ep = tokenEndpoint([[400, { error: "invalid_grant", error_description: "AADSTS50173: password changed" }]]);
    const provider = new OAuthAuthProvider(account, secrets, { fetch: ep.fetch });
    const err = await provider.imapAuth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthReauthRequiredError);
    expect((err as Error).message).toMatch(/Sign in again/);
  });

  it("tells Claude to run sign_in when no refresh token is stored", async () => {
    const provider = new OAuthAuthProvider(account, new MemorySecretStore(), { fetch: tokenEndpoint([]).fetch });
    await expect(provider.imapAuth()).rejects.toBeInstanceOf(OAuthSignInRequiredError);
    await expect(provider.imapAuth()).rejects.toThrow(/Not signed in yet .* ask me to run sign_in/);
  });

  it("reports a missing Microsoft client id at use time, not at construction", async () => {
    const noClient = AccountSchema.parse({ ...account, auth: { type: "oauth2", provider: "microsoft" } });
    const provider = new OAuthAuthProvider(noClient, new MemorySecretStore());
    await expect(provider.imapAuth()).rejects.toBeInstanceOf(OAuthConfigurationError);
  });

  it("fetches a fresh token after invalidate() (the connection manager does this after a rejected login)", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt");
    const ep = tokenEndpoint([
      [200, { access_token: "first", expires_in: 3600 }],
      [200, { access_token: "second", expires_in: 3600 }],
    ]);
    const provider = new OAuthAuthProvider(account, secrets, { fetch: ep.fetch, now: () => 0 });
    expect(await provider.accessToken()).toBe("first");
    await provider.invalidate();
    expect(await provider.accessToken()).toBe("second");
  });
});
```

`src/config/__tests__/env-auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { authFromEnv } from "../env-auth.js";
import { AuthSchema } from "../schema.js";

describe("authFromEnv", () => {
  it("defaults to password and keeps the username", () => {
    expect(authFromEnv({})).toEqual({ type: "password" });
    expect(authFromEnv({ IMAP_MCP_AUTH: "" }, "max")).toEqual({ type: "password", username: "max" });
  });

  it("maps Microsoft settings", () => {
    const auth = authFromEnv({
      IMAP_MCP_AUTH: "Microsoft",
      IMAP_MCP_OAUTH_CLIENT_ID: " 11111111-2222-3333-4444-555555555555 ",
      IMAP_MCP_OAUTH_TENANT: "firma.at",
      IMAP_MCP_OAUTH_CLIENT_SECRET: "ignored-for-microsoft",
    });
    expect(auth).toEqual({ type: "oauth2", provider: "microsoft", clientId: "11111111-2222-3333-4444-555555555555", tenant: "firma.at" });
    expect(AuthSchema.safeParse(auth).success).toBe(true);
  });

  it("maps Google settings including the client secret", () => {
    expect(authFromEnv({ IMAP_MCP_AUTH: "google", IMAP_MCP_OAUTH_CLIENT_ID: "x.apps.googleusercontent.com", IMAP_MCP_OAUTH_CLIENT_SECRET: "s" })).toEqual({
      type: "oauth2",
      provider: "google",
      clientId: "x.apps.googleusercontent.com",
      clientSecret: "s",
    });
  });

  it("leaves a missing client id to the first use (clear message there)", () => {
    expect(authFromEnv({ IMAP_MCP_AUTH: "microsoft" })).toEqual({ type: "oauth2", provider: "microsoft" });
  });

  it("rejects unknown methods", () => {
    expect(() => authFromEnv({ IMAP_MCP_AUTH: "kerberos" })).toThrow(/IMAP_MCP_AUTH must be/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/auth/oauth/__tests__/provider.test.ts src/config/__tests__/env-auth.test.ts`
Expected: FAIL — `Failed to resolve import "../provider.js"` and `"../env-auth.js"`.

- [ ] **Step 3: Implement**

`src/auth/oauth/provider.ts`:

```ts
import type { AccountConfig } from "../../config/schema.js";
import type { SecretStore } from "../../secrets/store.js";
import type { AuthProvider, ImapAuth, SmtpAuth } from "../provider.js";
import { OAuthReauthRequiredError, OAuthSignInRequiredError, OAuthTokenError } from "./errors.js";
import { profileFor, type OAuthProfile } from "./profiles.js";
import { refreshAccessToken, type TokenDeps, type TokenSet } from "./tokens.js";

/** Refresh this long before the provider's expiry so a token never dies mid-command. */
export const EXPIRY_SKEW_MS = 2 * 60_000;

export class OAuthAuthProvider implements AuthProvider {
  private cached?: TokenSet;
  private refreshing?: Promise<TokenSet>;

  constructor(
    private readonly account: AccountConfig,
    private readonly secrets: SecretStore,
    private readonly deps: TokenDeps & { profile?: OAuthProfile } = {},
  ) {}

  get username(): string {
    return (this.account.auth.type === "oauth2" ? this.account.auth.username : undefined) ?? this.account.email;
  }

  async accessToken(): Promise<string> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && this.cached.expiresAt - EXPIRY_SKEW_MS > now) return this.cached.accessToken;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return (await this.refreshing).accessToken;
  }

  private async refresh(): Promise<TokenSet> {
    // Resolved lazily: a missing client id becomes a tool error, not a server crash at startup.
    const profile = this.deps.profile ?? profileFor(this.account);
    const refreshToken = await this.secrets.get(this.account.id, "oauthRefreshToken");
    if (!refreshToken) throw new OAuthSignInRequiredError(this.account.id);

    let tokens: TokenSet;
    try {
      tokens = await refreshAccessToken(profile, refreshToken, this.deps);
    } catch (err) {
      if (err instanceof OAuthTokenError && (err.code === "invalid_grant" || err.code === "interaction_required")) {
        throw new OAuthReauthRequiredError(this.account.id, err.description ?? err.code);
      }
      throw err;
    }
    // Microsoft rotates refresh tokens; keep the newest one or the next restart fails.
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      await this.secrets.set(this.account.id, "oauthRefreshToken", tokens.refreshToken);
    }
    this.cached = tokens;
    return tokens;
  }

  async imapAuth(): Promise<ImapAuth> {
    return { user: this.username, accessToken: await this.accessToken() };
  }

  async smtpAuth(): Promise<SmtpAuth> {
    return { type: "OAuth2", user: this.username, accessToken: await this.accessToken() };
  }

  /** Plan 2's ImapConnectionManager calls this after a rejected login and retries once. */
  async invalidate(): Promise<void> {
    this.cached = undefined;
  }
}
```

`src/config/env-auth.ts`:

```ts
import type { AccountConfig } from "./schema.js";

/**
 * Sign-in method of the env-only account (MCPB bundle, containers):
 * IMAP_MCP_AUTH = password (default) | microsoft | google, plus IMAP_MCP_OAUTH_CLIENT_ID,
 * IMAP_MCP_OAUTH_CLIENT_SECRET (Google only) and IMAP_MCP_OAUTH_TENANT (Microsoft only).
 * Missing client ids are reported when the account is first used, so Claude can show the message.
 */
export function authFromEnv(env: NodeJS.ProcessEnv, username?: string): AccountConfig["auth"] {
  const kind = (env.IMAP_MCP_AUTH ?? "").trim().toLowerCase() || "password";
  const user = username ? { username } : {};
  if (kind === "password") return { type: "password", ...user };
  if (kind !== "microsoft" && kind !== "google") {
    throw new Error(`IMAP_MCP_AUTH must be "password", "microsoft" or "google" (got "${env.IMAP_MCP_AUTH}").`);
  }
  const value = (name: string) => env[name]?.trim() || undefined;
  const clientId = value("IMAP_MCP_OAUTH_CLIENT_ID");
  const clientSecret = kind === "google" ? value("IMAP_MCP_OAUTH_CLIENT_SECRET") : undefined;
  const tenant = kind === "microsoft" ? value("IMAP_MCP_OAUTH_TENANT") : undefined;
  return {
    type: "oauth2",
    provider: kind,
    ...user,
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(tenant ? { tenant } : {}),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/auth/oauth/__tests__/provider.test.ts src/config/__tests__/env-auth.test.ts`
Expected: PASS (6 + 5 tests).

- [ ] **Step 5: Return the OAuth provider from `createAuthProvider`**

In `src/auth/provider.ts` add below the `store.js` import

```ts
import { OAuthAuthProvider } from "./oauth/provider.js";
```

and replace the end of `createAuthProvider`

```ts
  if (account.auth.type === "password") return new PasswordAuthProvider(account, secrets);
  throw new Error(
    `The mail account "${account.id}" is configured for ${account.auth.provider} sign-in (OAuth2), which this version does not support yet.`,
  );
```

with

```ts
  if (account.auth.type === "password") return new PasswordAuthProvider(account, secrets);
  return new OAuthAuthProvider(account, secrets);
```

In Plan 2's `src/auth/__tests__/provider.test.ts` add `import { OAuthAuthProvider } from "../oauth/provider.js";` and replace the test "refuses OAuth2 accounts until OAuth support ships" with:

```ts
  it("returns the OAuth provider for oauth2 accounts, which asks for sign_in until a sign-in is stored", async () => {
    const provider = createAuthProvider(account({ auth: { type: "oauth2", provider: "microsoft", clientId: "cid" } }), store({}));
    expect(provider).toBeInstanceOf(OAuthAuthProvider);
    await expect(provider.imapAuth()).rejects.toThrow(/ask me to run sign_in/);
  });
```

The provider resolves the OAuth profile lazily: a missing Microsoft client ID becomes a tool error with instructions, an account without stored sign-in answers "Not signed in yet — ask me to run sign_in", and neither crashes the server at start. Plan 2 already calls `auth.imapAuth()` on every IMAP connect (Google and Microsoft end OAuth IMAP sessions when the ~1 h token expires; the reconnect gets a fresh token), `auth.invalidate()` plus one retry after a rejected login, and `auth.smtpAuth()` for every message — no further change is needed there.

- [ ] **Step 6: Let env-only (bundle) accounts use OAuth**

In `src/config/load.ts` add below the logger import

```ts
import { authFromEnv } from "./env-auth.js";
```

and in `configFromEnv` replace

```ts
          auth: { type: "password", ...(username ? { username } : {}) },
```

with

```ts
          auth: authFromEnv(env, username),
```

- [ ] **Step 7: Run the whole suite**

Run: `npm run build && npm run typecheck && npm test`
Expected: all tests pass (Plan 2's env-mode tests still produce `{ type: "password" }` without `IMAP_MCP_AUTH`).

- [ ] **Step 8: Commit**

```bash
git add src/auth src/config
git commit -m "feat(auth): OAuth2 auth provider with token refresh and rotation; OAuth in env-only mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `sign_in` tool — sign in from the chat

Claude Desktop bundle users never run the CLI. For them the server itself starts the browser sign-in. One tool call waits at most 45 s (MCP clients cancel long requests, often after 60 s); the browser flow keeps running for up to five minutes and the next `sign_in` call picks up the result.

**Files:**
- Create: `src/auth/oauth/sign-in-manager.ts`, `src/tools/sign-in.ts`
- Test: `src/auth/oauth/__tests__/sign-in-manager.test.ts`, `src/tools/__tests__/sign-in.test.ts`
- Modify: `src/context.ts` (expose `secrets`), `src/tools/index.ts` (append to `ALL_TOOLS`)

**Interfaces:**
- Consumes: `runLoopbackAuthorization`, `InteractiveAuthOptions.onAuthorizeUrl`, `AuthorizedTokens` (Task 5); `profileFor`, `refreshAccessToken`, `OAuthTokenError` (Task 4); `defineTool`, `jsonResult`, `errorResult`, `createTestApp` (Plan 2).
- Produces:
  - `SIGN_IN_TIMEOUT_MS = 300000`, `type SignInStatus = { state: "not_needed" } | { state: "signed_in" } | { state: "waiting"; url; expiresAt } | { state: "failed"; error }`
  - `interface SignInDeps { secrets; authorize?; openBrowser?; tokenDeps?; now? }`, `class SignInManager { signIn(account, waitMs): Promise<SignInStatus> }`
  - Tool `sign_in` (tier `"always"`, input `{}` + automatic `account`, annotations `{ readOnlyHint: false, destructiveHint: false, openWorldHint: true }`), `SIGN_IN_WAIT_MS = 45000`, `register(server, app, manager?)`
  - **Contract addition:** `AppContext.secrets: SecretStore`

- [ ] **Step 1: Write the failing tests**

`src/auth/oauth/__tests__/sign-in-manager.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AccountSchema } from "../../../config/schema.js";
import { MemorySecretStore } from "../../../secrets/memory-store.js";
import { OAuthAuthorizationError, OAuthConfigurationError } from "../errors.js";
import type { AuthorizedTokens, InteractiveAuthOptions } from "../flow.js";
import type { OAuthProfile } from "../profiles.js";
import { SignInManager } from "../sign-in-manager.js";
import type { FetchLike } from "../tokens.js";

const oauthAccount = AccountSchema.parse({
  id: "work",
  email: "max@firma.at",
  imap: { host: "outlook.office365.com", port: 993 },
  auth: { type: "oauth2", provider: "microsoft", clientId: "cid" },
  locale: "de",
});

/** Fake browser flow: announces the URL, then waits until the test settles it. */
function controllableAuthorize() {
  let settle!: { resolve: (t: AuthorizedTokens) => void; reject: (e: Error) => void };
  const calls: InteractiveAuthOptions[] = [];
  const authorize = (_profile: OAuthProfile, opts: InteractiveAuthOptions) => {
    calls.push(opts);
    return new Promise<AuthorizedTokens>((resolve, reject) => {
      settle = { resolve, reject };
      opts.onAuthorizeUrl?.("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1");
    });
  };
  return { authorize, calls, complete: (rt: string) => settle.resolve({ accessToken: "at", refreshToken: rt, expiresAt: 0 }), fail: (e: Error) => settle.reject(e) };
}

const answering = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });

describe("SignInManager", () => {
  it("is not needed for password accounts", async () => {
    const manager = new SignInManager({ secrets: new MemorySecretStore() });
    const password = AccountSchema.parse({ id: "main", email: "a@b.at", imap: { host: "h", port: 993 } });
    expect(await manager.signIn(password, 10)).toEqual({ state: "not_needed" });
  });

  it("reports signed_in when the stored refresh token still works", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt");
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets, authorize: fake.authorize, tokenDeps: { fetch: answering(200, { access_token: "a", expires_in: 3600 }) } });
    expect(await manager.signIn(oauthAccount, 10)).toEqual({ state: "signed_in" });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns the sign-in link while waiting and stores the token when the user finishes", async () => {
    const secrets = new MemorySecretStore();
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets, authorize: fake.authorize, now: () => 1000 });

    const first = await manager.signIn(oauthAccount, 10);
    expect(first).toEqual({ state: "waiting", url: expect.stringContaining("login.microsoftonline.com"), expiresAt: 1000 + 5 * 60_000 });
    expect(fake.calls[0]).toMatchObject({ loginHint: "max@firma.at", language: "de", timeoutMs: 300_000 });

    fake.complete("rt-new");
    expect(await manager.signIn(oauthAccount, 1000)).toEqual({ state: "signed_in" });
    expect(await secrets.get("work", "oauthRefreshToken")).toBe("rt-new");
    expect(fake.calls).toHaveLength(1);
  });

  it("starts a new sign-in when the stored token was revoked", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "revoked");
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets, authorize: fake.authorize, tokenDeps: { fetch: answering(400, { error: "invalid_grant" }) } });
    expect((await manager.signIn(oauthAccount, 10)).state).toBe("waiting");
  });

  it("shares one browser flow between repeated calls", async () => {
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets: new MemorySecretStore(), authorize: fake.authorize });
    await manager.signIn(oauthAccount, 10);
    await manager.signIn(oauthAccount, 10);
    expect(fake.calls).toHaveLength(1);
  });

  it("reports a cancelled sign-in once and then allows a new attempt", async () => {
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets: new MemorySecretStore(), authorize: fake.authorize });
    await manager.signIn(oauthAccount, 10);
    fake.fail(new OAuthAuthorizationError("access_denied"));
    expect(await manager.signIn(oauthAccount, 1000)).toEqual({ state: "failed", error: "Sign-in was cancelled or access was not granted." });
    expect((await manager.signIn(oauthAccount, 10)).state).toBe("waiting");
    expect(fake.calls).toHaveLength(2);
  });

  it("explains a missing Microsoft client id instead of opening a browser", async () => {
    const noClient = AccountSchema.parse({ ...oauthAccount, auth: { type: "oauth2", provider: "microsoft" } });
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets: new MemorySecretStore(), authorize: fake.authorize });
    await expect(manager.signIn(noClient, 10)).rejects.toBeInstanceOf(OAuthConfigurationError);
    expect(fake.calls).toHaveLength(0);
  });
});
```

`src/tools/__tests__/sign-in.test.ts` (uses Plan 2's `createTestApp`; its default account signs in with a password):

```ts
import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as signIn from "../sign-in.js";

describe("sign_in tool", () => {
  it("is available for every account and annotated as open-world, not destructive", async () => {
    const h = await createTestApp().connect(signIn.register);
    try {
      expect(await h.listTools()).toContain("sign_in");
      expect(await h.annotations("sign_in")).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    } finally {
      await h.close();
    }
  });

  it("tells Claude that password mailboxes need no sign-in", async () => {
    const h = await createTestApp().connect(signIn.register);
    try {
      const res = await h.call("sign_in", {});
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ status: "not_needed" });
    } finally {
      await h.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/auth/oauth/__tests__/sign-in-manager.test.ts src/tools/__tests__/sign-in.test.ts`
Expected: FAIL — `Failed to resolve import "../sign-in-manager.js"` and `"../sign-in.js"`.

- [ ] **Step 3: Expose the secret store on the app context**

In `src/context.ts`, in `interface AppContext` replace

```ts
  readonly observers: ToolObserver[];
  resolveAccount(id: string | undefined): AccountRuntime;
```

with

```ts
  readonly observers: ToolObserver[];
  /** The store the app was created with (the sign_in tool saves refresh tokens here). */
  readonly secrets: SecretStore;
  resolveAccount(id: string | undefined): AccountRuntime;
```

and in the object returned by `createAppContext` replace `    observers: [],` with

```ts
    observers: [],
    secrets,
```

`createTestApp` passes its own store to `createAppContext`, so tests get it automatically.

- [ ] **Step 4: Implement the manager and the tool**

`src/auth/oauth/sign-in-manager.ts`:

```ts
import type { AccountConfig } from "../../config/schema.js";
import type { SecretStore } from "../../secrets/store.js";
import { OAuthTokenError } from "./errors.js";
import { runLoopbackAuthorization, type AuthorizedTokens, type InteractiveAuthOptions } from "./flow.js";
import { profileFor, type OAuthProfile } from "./profiles.js";
import { refreshAccessToken, type TokenDeps } from "./tokens.js";

/** A browser sign-in started from the server stays open this long. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export type SignInStatus =
  | { state: "not_needed" }
  | { state: "signed_in" }
  | { state: "waiting"; url: string; expiresAt: number }
  | { state: "failed"; error: string };

export interface SignInDeps {
  secrets: SecretStore;
  authorize?(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens>;
  openBrowser?(url: string): Promise<boolean>;
  tokenDeps?: TokenDeps;
  now?(): number;
}

interface PendingSignIn {
  url: string;
  expiresAt: number;
  finished: Promise<void>;
  outcome?: { ok: true } | { ok: false; error: Error };
}

function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Browser sign-in started from the MCP server process, for users who never run the CLI
 * (Claude Desktop bundle). One sign_in tool call waits a bounded time; the flow keeps running
 * in the background for up to five minutes and a later call picks up the result.
 */
export class SignInManager {
  private readonly pending = new Map<string, PendingSignIn>();

  constructor(private readonly deps: SignInDeps) {}

  async signIn(account: AccountConfig, waitMs: number): Promise<SignInStatus> {
    if (account.auth.type !== "oauth2") return { state: "not_needed" };

    let flow = this.pending.get(account.id);
    if (!flow) {
      if (await this.hasWorkingSignIn(account)) return { state: "signed_in" };
      flow = await this.start(account);
    }

    await waitAtMost(flow.finished, waitMs);
    if (!flow.outcome) return { state: "waiting", url: flow.url, expiresAt: flow.expiresAt };
    this.pending.delete(account.id);
    return flow.outcome.ok ? { state: "signed_in" } : { state: "failed", error: flow.outcome.error.message };
  }

  /** A stored refresh token that the provider still accepts. */
  private async hasWorkingSignIn(account: AccountConfig): Promise<boolean> {
    const refreshToken = await this.deps.secrets.get(account.id, "oauthRefreshToken");
    if (!refreshToken) return false;
    try {
      const tokens = await refreshAccessToken(profileFor(account), refreshToken, this.deps.tokenDeps);
      if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
        await this.deps.secrets.set(account.id, "oauthRefreshToken", tokens.refreshToken);
      }
      return true;
    } catch (err) {
      if (err instanceof OAuthTokenError && (err.code === "invalid_grant" || err.code === "interaction_required")) return false;
      throw err;
    }
  }

  private start(account: AccountConfig): Promise<PendingSignIn> {
    const profile = profileFor(account); // a missing client id throws here → tool error with instructions
    const now = (this.deps.now ?? Date.now)();
    const authorize = this.deps.authorize ?? runLoopbackAuthorization;
    return new Promise<PendingSignIn>((resolveStarted, rejectStarted) => {
      const flow: PendingSignIn = { url: "", expiresAt: now + SIGN_IN_TIMEOUT_MS, finished: Promise.resolve() };
      flow.finished = authorize(profile, {
        print: () => {}, // the URL travels in the tool result instead
        language: account.locale,
        loginHint: account.email,
        timeoutMs: SIGN_IN_TIMEOUT_MS,
        openBrowser: this.deps.openBrowser,
        tokenDeps: this.deps.tokenDeps,
        onAuthorizeUrl: (url) => {
          flow.url = url;
          this.pending.set(account.id, flow);
          resolveStarted(flow);
        },
      }).then(
        async (tokens) => {
          await this.deps.secrets.set(account.id, "oauthRefreshToken", tokens.refreshToken);
          flow.outcome = { ok: true };
        },
        (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          flow.outcome = { ok: false, error };
          rejectStarted(error); // only matters when the flow failed before the URL existed
        },
      );
    });
  }
}
```

`src/tools/sign-in.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { SignInManager } from "../auth/oauth/sign-in-manager.js";
import { defineTool } from "./shared/define-tool.js";
import { errorResult, jsonResult } from "./shared/result.js";

/** One sign_in call waits this long for the browser; stays below common MCP client request timeouts. */
export const SIGN_IN_WAIT_MS = 45_000;

export function register(server: McpServer, app: AppContext, manager = new SignInManager({ secrets: app.secrets })) {
  defineTool(
    server,
    app,
    {
      name: "sign_in",
      title: "Sign in to a mailbox",
      description:
        "Sign in to a Microsoft 365 / Outlook.com or Google mailbox that uses browser sign-in. Opens the sign-in page " +
        "in the browser on this computer and returns the link. If the result says \"waiting\", the user finishes the " +
        "sign-in in the browser and you call sign_in again. Not needed for mailboxes that use a password.",
      tier: "always",
      input: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      errorPrefix: "Error signing in",
    },
    async (_args, inv) => {
      const account = inv.account.config;
      const status = await manager.signIn(account, SIGN_IN_WAIT_MS);
      inv.record({ action: "sign_in", outcome: status.state });
      switch (status.state) {
        case "not_needed":
          return jsonResult({ status: "not_needed", message: `${account.email} signs in with a password; no browser sign-in is needed.` });
        case "signed_in":
          return jsonResult({ status: "signed_in", message: `Signed in to ${account.email}. The mailbox can be used now.` });
        case "waiting":
          return jsonResult({
            status: "waiting",
            signInUrl: status.url,
            expiresAt: new Date(status.expiresAt).toISOString(),
            message:
              "The sign-in page was opened in the browser on this computer (if not, open signInUrl). " +
              "After signing in there, ask me to run sign_in again to finish.",
          });
        case "failed":
          return errorResult("Error signing in", status.error);
      }
    },
  );
}
```

In `src/tools/index.ts` import it next to `health-check`

```ts
import * as signIn from "./sign-in.js";
```

and append it to the "always available" group of `ALL_TOOLS`:

```ts
  // always available
  listAccounts.register,
  healthCheck.register,
  signIn.register,
```

(`src/__tests__/server.test.ts` counts `ALL_TOOLS.length`, so it needs no change. Plan 3 appends its tools to the same list; resolve a merge conflict there by keeping both additions.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/auth/oauth/__tests__/sign-in-manager.test.ts src/tools/__tests__/sign-in.test.ts`
Expected: PASS (7 + 2 tests).

- [ ] **Step 6: Manual check in Claude Desktop (Microsoft 365 account in env mode)**

Start the built server with `IMAP_MCP_EMAIL=<m365 address>`, `IMAP_MCP_AUTH=microsoft`, `IMAP_MCP_OAUTH_CLIENT_ID=<id>` in Claude Desktop's config, then ask "Zeig mir meine ungelesenen Mails". Expected: Claude reports "Not signed in yet — ask me to run sign_in", runs `sign_in`, the browser opens the Microsoft page, the tool returns `status: "waiting"` with the link; after signing in, the next `sign_in` returns `signed_in` and the unread mails are listed. Restart Claude Desktop: no new sign-in needed.

- [ ] **Step 7: Commit**

```bash
git add src/auth/oauth/sign-in-manager.ts src/auth/oauth/__tests__/sign-in-manager.test.ts src/tools/sign-in.ts src/tools/__tests__/sign-in.test.ts src/context.ts src/tools/index.ts
git commit -m "feat(auth): sign_in tool for browser sign-in from the chat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Provider presets and auto-detection

**Files:**
- Create: `src/onboarding/presets.ts`, `src/onboarding/autoconfig.ts`
- Test: `src/onboarding/__tests__/autoconfig.test.ts`
- Modify: `src/index.ts` (env-only mode fills hosts)

**Interfaces:**
- Produces:
  - `type AuthKind = "password" | "app-password" | "oauth2-microsoft" | "oauth2-google" | "bridge-password"`, `interface ServerSetting { host; port; security: "implicit" | "starttls" }`, `interface LocalizedText { de: string; en: string }`
  - `interface ProviderPreset { id; name; domains; imap; smtp; auth; usernameStyle?; tenant?; helpUrl?; notes }`, `PROVIDER_PRESETS`, `MX_RULES`, `presetById(id)`
  - `interface DetectedProvider { presetId?; name; imap; smtp; auth; usernameStyle: "address" | "localpart"; tenant?; helpUrl?; notes; source: "domain" | "mx" | "autoconfig" | "guess" }`, `interface DetectDeps { resolveMx?; fetch?; timeoutMs?; network?: boolean }`
  - `parseAutoconfig(xml, email)`, `detectProvider(email, deps?)`, `withDetectedEndpoints(env, detect?)`

- [ ] **Step 1: Write the failing tests**

`src/onboarding/__tests__/autoconfig.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectProvider, parseAutoconfig, withDetectedEndpoints, type TextFetch } from "../autoconfig.js";
import { PROVIDER_PRESETS } from "../presets.js";

const GMX_LIKE = `<clientConfig version="1.1"><emailProvider id="example.org">
  <domain>example.org</domain><displayName>Example Mail</displayName>
  <incomingServer type="pop3"><hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
  <incomingServer type="imap"><hostname>imap.example.org</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></incomingServer>
  <incomingServer type="imap"><hostname>imap.example.org</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.%EMAILDOMAIN%</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username></outgoingServer>
</emailProvider></clientConfig>`;

const noNetwork = { resolveMx: async () => [], fetch: (async () => ({ status: 404, text: async () => "" })) as TextFetch };

describe("parseAutoconfig", () => {
  it("prefers implicit TLS, substitutes placeholders and detects local-part logins", () => {
    expect(parseAutoconfig(GMX_LIKE, "anna@example.org")).toMatchObject({
      name: "Example Mail",
      imap: { host: "imap.example.org", port: 993, security: "implicit" },
      smtp: { host: "smtp.example.org", port: 587, security: "starttls" },
      usernameStyle: "localpart",
    });
  });

  it("never auto-configures plaintext servers", () => {
    const plain = GMX_LIKE.replace(/STARTTLS|SSL/g, "plain");
    expect(parseAutoconfig(plain, "anna@example.org")).toBeUndefined();
  });

  it("rejects hostnames that are not plain DNS names", () => {
    const evil = GMX_LIKE.replace(/imap\.example\.org/g, "imap.example.org/../x");
    expect(parseAutoconfig(evil, "anna@example.org")).toBeUndefined();
  });
});

describe("detectProvider", () => {
  it("knows big providers by domain without any lookup", async () => {
    const found = await detectProvider("max@gmx.at", { network: false });
    expect(found).toMatchObject({ presetId: "gmx", source: "domain", imap: { host: "imap.gmx.net", port: 993 } });
  });

  it("recognises Microsoft 365 custom domains by MX", async () => {
    const found = await detectProvider("office@firma-beispiel.at", {
      resolveMx: async () => [{ exchange: "firma-beispiel-at.mail.protection.outlook.com", priority: 0 }],
      fetch: noNetwork.fetch,
    });
    expect(found).toMatchObject({ presetId: "microsoft365", auth: "oauth2-microsoft", source: "mx", smtp: { port: 587 } });
  });

  it("recognises Google Workspace by MX", async () => {
    const found = await detectProvider("office@firma.at", {
      resolveMx: async () => [{ exchange: "smtp.google.com", priority: 1 }],
      fetch: noNetwork.fetch,
    });
    expect(found.presetId).toBe("google-workspace");
  });

  it("uses the provider's own autoconfig before Mozilla's ISPDB", async () => {
    const urls: string[] = [];
    const fetch: TextFetch = async (url) => {
      urls.push(url);
      return { status: 200, text: async () => GMX_LIKE };
    };
    const found = await detectProvider("anna@example.org", { resolveMx: async () => [], fetch });
    expect(found.source).toBe("autoconfig");
    expect(urls[0]).toBe("https://autoconfig.example.org/mail/config-v1.1.xml?emailaddress=anna%40example.org");
  });

  it("falls back to a clearly marked guess", async () => {
    const found = await detectProvider("info@kleine-firma.at", noNetwork);
    expect(found).toMatchObject({ source: "guess", imap: { host: "imap.kleine-firma.at" } });
    expect(found.notes[0].de).toMatch(/geraten/);
  });

  it("rejects input that is not an address", async () => {
    await expect(detectProvider("no-at-sign", noNetwork)).rejects.toThrow(/not a valid email/);
  });

  it("keeps preset data consistent with the TLS policy", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.imap.security === "implicit").toBe(p.imap.port === 993);
      expect(p.smtp.security === "implicit").toBe(p.smtp.port === 465);
    }
  });
});

describe("withDetectedEndpoints (env-only mode)", () => {
  it("fills hosts and ports when only the email is given", async () => {
    const env = await withDetectedEndpoints({ IMAP_MCP_EMAIL: "max@web.de" }, (e) => detectProvider(e, { network: false }));
    expect(env).toMatchObject({
      IMAP_MCP_IMAP_HOST: "imap.web.de",
      IMAP_MCP_IMAP_PORT: "993",
      IMAP_MCP_SMTP_HOST: "smtp.web.de",
      IMAP_MCP_SMTP_PORT: "587",
    });
  });

  it("never overrides an explicit host and never uses guesses", async () => {
    const explicit = { IMAP_MCP_EMAIL: "max@web.de", IMAP_MCP_IMAP_HOST: "mail.example.com" };
    expect(await withDetectedEndpoints(explicit)).toBe(explicit);
    const guessOnly = { IMAP_MCP_EMAIL: "info@kleine-firma.at" };
    expect(await withDetectedEndpoints(guessOnly, (e) => detectProvider(e, noNetwork))).toBe(guessOnly);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/onboarding/__tests__/autoconfig.test.ts`
Expected: FAIL — `Failed to resolve import "../autoconfig.js"`.

- [ ] **Step 3: Implement**

`src/onboarding/presets.ts` (hosts cross-checked against Mozilla's ISPDB on 2026-10-14; every help URL answered HTTP 200 that day):

```ts
export type AuthKind = "password" | "app-password" | "oauth2-microsoft" | "oauth2-google" | "bridge-password";

export interface ServerSetting {
  host: string;
  port: number;
  /** Must agree with connection-security.ts: implicit TLS only on 993 (IMAP) / 465 (SMTP). */
  security: "implicit" | "starttls";
}

export interface LocalizedText {
  de: string;
  en: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  /** Email domains that identify the provider without any lookup. */
  domains: string[];
  imap: ServerSetting;
  smtp: ServerSetting;
  auth: AuthKind;
  /** Login name: the full address (default) or only the part before "@". */
  usernameStyle?: "address" | "localpart";
  /** Microsoft authority tenant for oauth2-microsoft presets. */
  tenant?: string;
  helpUrl?: string;
  notes: LocalizedText[];
}

const implicitImap = (host: string): ServerSetting => ({ host, port: 993, security: "implicit" });
const implicitSmtp = (host: string): ServerSetting => ({ host, port: 465, security: "implicit" });
const submission = (host: string): ServerSetting => ({ host, port: 587, security: "starttls" });

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "gmail",
    name: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    imap: implicitImap("imap.gmail.com"),
    smtp: implicitSmtp("smtp.gmail.com"),
    auth: "app-password",
    helpUrl: "https://support.google.com/accounts/answer/185833",
    notes: [
      {
        de: "Gmail verlangt ein App-Passwort. Dafür muss die Bestätigung in zwei Schritten aktiv sein.",
        en: "Gmail requires an app password, which needs 2-Step Verification to be turned on.",
      },
    ],
  },
  {
    id: "google-workspace",
    name: "Google Workspace",
    domains: [],
    imap: implicitImap("imap.gmail.com"),
    smtp: implicitSmtp("smtp.gmail.com"),
    auth: "oauth2-google",
    notes: [
      {
        de: "Anmeldung über den internen OAuth-Client Ihrer Organisation (siehe docs/guide/providers.md) oder – falls vom Administrator erlaubt – mit einem App-Passwort.",
        en: "Sign in with your organisation's internal OAuth client (see docs/guide/providers.md) or, if your administrator allows it, with an app password.",
      },
    ],
  },
  {
    id: "microsoft365",
    name: "Microsoft 365",
    domains: [],
    imap: implicitImap("outlook.office365.com"),
    smtp: submission("smtp.office365.com"),
    auth: "oauth2-microsoft",
    tenant: "organizations",
    helpUrl: "https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission",
    notes: [
      {
        de: "Zum Senden muss ein Administrator „Authenticated SMTP“ für das Postfach aktivieren.",
        en: "To send mail, an administrator must enable Authenticated SMTP for the mailbox.",
      },
    ],
  },
  {
    id: "outlook-com",
    name: "Outlook.com",
    domains: ["outlook.com", "outlook.de", "outlook.at", "hotmail.com", "hotmail.de", "live.com", "live.de", "live.at", "msn.com"],
    imap: implicitImap("outlook.office365.com"),
    smtp: submission("smtp-mail.outlook.com"),
    auth: "oauth2-microsoft",
    tenant: "consumers",
    notes: [
      {
        de: "Persönliche Microsoft-Konten benötigen eine App-Registrierung, die persönliche Konten zulässt.",
        en: "Personal Microsoft accounts need an app registration that allows personal accounts.",
      },
    ],
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: implicitImap("imap.mail.me.com"),
    smtp: submission("smtp.mail.me.com"),
    auth: "app-password",
    helpUrl: "https://support.apple.com/en-us/102654",
    notes: [{ de: "iCloud verlangt ein app-spezifisches Passwort.", en: "iCloud requires an app-specific password." }],
  },
  {
    id: "yahoo",
    name: "Yahoo Mail",
    domains: ["yahoo.com", "yahoo.de", "yahoo.at", "ymail.com", "rocketmail.com"],
    imap: implicitImap("imap.mail.yahoo.com"),
    smtp: implicitSmtp("smtp.mail.yahoo.com"),
    auth: "app-password",
    helpUrl: "https://help.yahoo.com/kb/SLN15241.html",
    notes: [{ de: "Yahoo verlangt ein App-Passwort.", en: "Yahoo requires an app password." }],
  },
  {
    id: "gmx",
    name: "GMX",
    domains: ["gmx.de", "gmx.at", "gmx.ch", "gmx.net", "gmx.eu", "gmx.biz", "gmx.org", "gmx.info"],
    imap: implicitImap("imap.gmx.net"),
    smtp: implicitSmtp("mail.gmx.net"),
    auth: "password",
    helpUrl: "https://hilfe.gmx.net/pop-imap/einschalten.html",
    notes: [
      {
        de: "In den GMX-Einstellungen muss „POP3/IMAP Abruf“ eingeschaltet sein. Mit Zwei-Faktor-Anmeldung ist ein anwendungsspezifisches Passwort nötig.",
        en: 'Turn on "POP3/IMAP access" in the GMX settings. With two-factor login an application-specific password is required.',
      },
    ],
  },
  {
    id: "webde",
    name: "WEB.DE",
    domains: ["web.de"],
    imap: implicitImap("imap.web.de"),
    smtp: submission("smtp.web.de"),
    auth: "password",
    usernameStyle: "localpart",
    helpUrl: "https://hilfe.web.de/pop-imap/einschalten.html",
    notes: [
      {
        de: "In den WEB.DE-Einstellungen muss „POP3/IMAP Abruf“ eingeschaltet sein. Mit Zwei-Faktor-Anmeldung ist ein anwendungsspezifisches Passwort nötig.",
        en: 'Turn on "POP3/IMAP access" in the WEB.DE settings. With two-factor login an application-specific password is required.',
      },
    ],
  },
  {
    id: "ionos",
    name: "IONOS",
    domains: ["ionos.de"],
    imap: implicitImap("imap.ionos.de"),
    smtp: implicitSmtp("smtp.ionos.de"),
    auth: "password",
    notes: [
      {
        de: "IONOS akzeptiert nur Absenderadressen Ihrer eigenen Domain.",
        en: "IONOS only accepts sender addresses of your own domain.",
      },
    ],
  },
  {
    id: "strato",
    name: "STRATO",
    domains: ["strato.de"],
    imap: implicitImap("imap.strato.de"),
    smtp: implicitSmtp("smtp.strato.de"),
    auth: "password",
    notes: [],
  },
  {
    id: "t-online",
    name: "Telekom (t-online.de)",
    domains: ["t-online.de", "magenta.de"],
    imap: implicitImap("secureimap.t-online.de"),
    smtp: implicitSmtp("securesmtp.t-online.de"),
    auth: "password",
    helpUrl: "https://www.telekom.de/hilfe/festnetz-internet-tv/e-mail/e-mail-passwort",
    notes: [
      {
        de: "Verwenden Sie das separate E-Mail-Passwort aus dem Telekom Kundencenter, nicht Ihr Login-Passwort.",
        en: "Use the separate e-mail password from the Telekom customer centre, not your login password.",
      },
    ],
  },
  {
    id: "mailbox-org",
    name: "mailbox.org",
    domains: ["mailbox.org"],
    imap: implicitImap("imap.mailbox.org"),
    smtp: implicitSmtp("smtp.mailbox.org"),
    auth: "password",
    notes: [],
  },
  {
    id: "posteo",
    name: "Posteo",
    domains: ["posteo.de", "posteo.net", "posteo.at", "posteo.ch", "posteo.org", "posteo.eu"],
    imap: implicitImap("posteo.de"),
    smtp: implicitSmtp("posteo.de"),
    auth: "password",
    notes: [],
  },
  {
    id: "proton-bridge",
    name: "Proton Mail (Bridge)",
    domains: ["proton.me", "protonmail.com", "protonmail.ch", "pm.me"],
    imap: { host: "127.0.0.1", port: 1143, security: "starttls" },
    smtp: { host: "127.0.0.1", port: 1025, security: "starttls" },
    auth: "bridge-password",
    helpUrl: "https://proton.me/mail/bridge",
    notes: [
      {
        de: "Proton Mail Bridge muss laufen. Verwenden Sie das Bridge-Passwort und vertrauen Sie im Setup dem Zertifikat der Bridge.",
        en: "Proton Mail Bridge must be running. Use the Bridge password and trust the Bridge certificate during setup.",
      },
    ],
  },
];

/** MX host patterns that identify a provider for custom domains. */
export const MX_RULES: Array<{ pattern: RegExp; presetId: string }> = [
  { pattern: /\.mail\.protection\.outlook\.com\.?$/i, presetId: "microsoft365" },
  { pattern: /(^|\.)(google\.com|googlemail\.com)\.?$/i, presetId: "google-workspace" },
  { pattern: /(^|\.)(ionos\.[a-z.]+|kundenserver\.de)\.?$/i, presetId: "ionos" },
  { pattern: /(^|\.)rzone\.de\.?$/i, presetId: "strato" },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
```

`src/onboarding/autoconfig.ts`:

```ts
import { Resolver } from "node:dns/promises";
import {
  MX_RULES,
  PROVIDER_PRESETS,
  presetById,
  type AuthKind,
  type LocalizedText,
  type ProviderPreset,
  type ServerSetting,
} from "./presets.js";

export interface DetectedProvider {
  presetId?: string;
  name: string;
  imap: ServerSetting;
  smtp: ServerSetting;
  auth: AuthKind;
  usernameStyle: "address" | "localpart";
  tenant?: string;
  helpUrl?: string;
  notes: LocalizedText[];
  source: "domain" | "mx" | "autoconfig" | "guess";
}

export type MxResolver = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
export type TextFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface DetectDeps {
  resolveMx?: MxResolver;
  fetch?: TextFetch;
  timeoutMs?: number;
  /** false = only the built-in domain table (no DNS, no autoconfig requests). */
  network?: boolean;
}

function fromPreset(p: ProviderPreset, source: DetectedProvider["source"]): DetectedProvider {
  return {
    presetId: p.id,
    name: p.name,
    imap: p.imap,
    smtp: p.smtp,
    auth: p.auth,
    usernameStyle: p.usernameStyle ?? "address",
    tenant: p.tenant,
    helpUrl: p.helpUrl,
    notes: p.notes,
    source,
  };
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function tag(block: string, name: string): string | undefined {
  return block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i"))?.[1];
}

function fill(value: string, email: string): string {
  const [local, domain] = email.split("@");
  return value.replace(/%EMAILADDRESS%/g, email).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILDOMAIN%/g, domain);
}

/** First usable server of a type: TLS only, and implicit TLS only on the standard port. */
function pickServer(xml: string, kind: "incomingServer" | "outgoingServer", type: "imap" | "smtp", email: string) {
  const blocks = [...xml.matchAll(new RegExp(`<${kind}\\s+type="${type}"\\s*>([\\s\\S]*?)</${kind}>`, "gi"))].map((m) => m[1]);
  const implicitPort = type === "imap" ? 993 : 465;
  const candidates = blocks
    .map((b) => {
      const host = fill(tag(b, "hostname") ?? "", email).toLowerCase();
      const port = Number(tag(b, "port"));
      const socketType = (tag(b, "socketType") ?? "").toUpperCase();
      const username = tag(b, "username") ?? "%EMAILADDRESS%";
      if (!HOSTNAME.test(host) || !Number.isInteger(port)) return undefined;
      if (socketType === "SSL" && port === implicitPort) return { host, port, security: "implicit" as const, username };
      if (socketType === "STARTTLS" && port !== implicitPort && port !== 25) return { host, port, security: "starttls" as const, username };
      return undefined; // plaintext or unusual combinations are never auto-configured
    })
    .filter((c): c is NonNullable<typeof c> => c !== undefined);
  return candidates.find((c) => c.security === "implicit") ?? candidates[0];
}

/** Parse a Mozilla autoconfig (ISPDB / config-v1.1.xml) document. */
export function parseAutoconfig(xml: string, email: string): DetectedProvider | undefined {
  const imap = pickServer(xml, "incomingServer", "imap", email);
  const smtp = pickServer(xml, "outgoingServer", "smtp", email);
  if (!imap || !smtp) return undefined;
  return {
    name: tag(xml, "displayName") ?? email.split("@")[1],
    imap: { host: imap.host, port: imap.port, security: imap.security },
    smtp: { host: smtp.host, port: smtp.port, security: smtp.security },
    auth: "password",
    usernameStyle: imap.username === "%EMAILLOCALPART%" ? "localpart" : "address",
    notes: [],
    source: "autoconfig",
  };
}

async function fetchAutoconfig(email: string, domain: string, deps: DetectDeps): Promise<DetectedProvider | undefined> {
  const doFetch = deps.fetch ?? (fetch as unknown as TextFetch);
  const urls = [
    // the provider's own autoconfig (Mailcow and many hosters publish one) …
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    // … then Mozilla's ISPDB
    `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`,
  ];
  for (const url of urls) {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 5000) });
      if (res.status !== 200) continue;
      const found = parseAutoconfig(await res.text(), email);
      if (found) return found;
    } catch {
      // unreachable or not configured: try the next source
    }
  }
  return undefined;
}

async function lookupMx(domain: string, deps: DetectDeps): Promise<string[]> {
  const resolve: MxResolver =
    deps.resolveMx ??
    ((d) => {
      const resolver = new Resolver({ timeout: deps.timeoutMs ?? 3000, tries: 2 });
      return resolver.resolveMx(d);
    });
  try {
    const records = await resolve(domain);
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase());
  } catch {
    return [];
  }
}

/** Find IMAP/SMTP settings for an address: built-in table → MX records → autoconfig → guess. */
export async function detectProvider(email: string, deps: DetectDeps = {}): Promise<DetectedProvider> {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain || !HOSTNAME.test(domain)) throw new Error(`"${email}" is not a valid email address.`);

  const known = PROVIDER_PRESETS.find((p) => p.domains.includes(domain));
  if (known) return fromPreset(known, "domain");

  if (deps.network !== false) {
    for (const exchange of await lookupMx(domain, deps)) {
      const rule = MX_RULES.find((r) => r.pattern.test(exchange));
      const preset = rule && presetById(rule.presetId);
      if (preset) return fromPreset(preset, "mx");
    }
    const auto = await fetchAutoconfig(email.trim(), domain, deps);
    if (auto) return auto;
  }

  return {
    name: domain,
    imap: { host: `imap.${domain}`, port: 993, security: "implicit" },
    smtp: { host: `smtp.${domain}`, port: 465, security: "implicit" },
    auth: "password",
    usernameStyle: "address",
    notes: [
      {
        de: "Die Servernamen wurden geraten. Bitte mit den Angaben Ihres Anbieters vergleichen.",
        en: "The server names were guessed. Please compare them with your provider's instructions.",
      },
    ],
    source: "guess",
  };
}

/**
 * Env-only mode (MCPB bundle, containers): fill IMAP_MCP_IMAP_HOST/PORT and IMAP_MCP_SMTP_HOST/PORT
 * from detection when only IMAP_MCP_EMAIL is given. Guessed hosts are never used here because
 * nobody can confirm them before the password is sent.
 */
export async function withDetectedEndpoints(
  env: NodeJS.ProcessEnv,
  detect: (email: string) => Promise<DetectedProvider> = (e) => detectProvider(e),
): Promise<NodeJS.ProcessEnv> {
  const email = env.IMAP_MCP_EMAIL?.trim();
  if (!email || env.IMAP_MCP_IMAP_HOST?.trim()) return env;
  try {
    const found = await detect(email);
    if (found.source === "guess") return env;
    return {
      ...env,
      IMAP_MCP_IMAP_HOST: found.imap.host,
      IMAP_MCP_IMAP_PORT: env.IMAP_MCP_IMAP_PORT?.trim() || String(found.imap.port),
      IMAP_MCP_SMTP_HOST: env.IMAP_MCP_SMTP_HOST?.trim() || found.smtp.host,
      IMAP_MCP_SMTP_PORT: env.IMAP_MCP_SMTP_PORT?.trim() || String(found.smtp.port),
    };
  } catch {
    return env;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/onboarding/__tests__/autoconfig.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Fill hosts in env-only mode (bundle users only enter address and password)**

In `src/index.ts` add below the `loadConfig` import

```ts
import { withDetectedEndpoints } from "./onboarding/autoconfig.js";
```

and in `main()` replace

```ts
  const config = await loadConfig(process.env, { secrets });
```

with

```ts
  // Bundle users only enter address and password; hosts come from autodetection (IMAP_MCP_NO_AUTOCONFIG=1 disables it).
  const env = process.env.IMAP_MCP_NO_AUTOCONFIG === "1" ? process.env : await withDetectedEndpoints(process.env);
  const config = await loadConfig(env, { secrets });
```

`IMAP_MCP_NO_AUTOCONFIG=1` disables the DNS/autoconfig lookups (the email domain is sent to `autoconfig.<domain>` and `autoconfig.thunderbird.net`); Plan 5 lists it in the security pack.

- [ ] **Step 6: Run the whole suite**

Run: `npm run build && npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/onboarding/presets.ts src/onboarding/autoconfig.ts src/onboarding/__tests__/autoconfig.test.ts src/index.ts
git commit -m "feat(onboarding): provider presets, MX and autoconfig detection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Plain-language diagnosis and connection test

**Files:**
- Create: `src/onboarding/diagnose.ts`, `src/onboarding/connection-test.ts`
- Test: `src/onboarding/__tests__/connection-test.test.ts`

**Interfaces:**
- Consumes: OAuth errors (Task 4), `SecretStoreUnavailableError` (Task 1), `presetById`, `LocalizedText` (Task 9), `imapSecurityOptions`, `smtpSecurityOptions`, `pinFromEndpoint`, `CertificatePinMismatchError` (Task 6), `FakeImap` (Plan 1 test helper).
- Produces:
  - `isAuthenticationFailure(err): boolean`
  - `type DiagnosisCode` (auth_failed, app_password_required, smtp_auth_disabled, basic_auth_disabled, certificate_untrusted, certificate_expired, certificate_hostname, certificate_pin_mismatch, starttls_missing, connection_refused, timeout, host_not_found, oauth_reauth, oauth_config, oauth_failed, keychain_unavailable, unknown)
  - `interface Diagnosis { code; message: LocalizedText; offerCertificatePinning? }`, `interface DiagnoseContext { protocol; host; port; presetId? }`, `diagnose(err, ctx): Diagnosis`
  - `interface CapabilitySummary { specialUse; uidplus; move; idle; customKeywords }`, `type StepResult<T>`, `interface AccountTestReport { imap; smtp? }`, `interface ImapProbeClient`, `interface ConnectionTestDeps { connectImap?; verifySmtp?; presetId? }`
  - `testAccountConnection(account, provider, deps?): Promise<AccountTestReport>`

- [ ] **Step 1: Write the failing tests**

`src/onboarding/__tests__/connection-test.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AccountSchema } from "../../config/schema.js";
import { CertificatePinMismatchError } from "../../connection-security.js";
import { OAuthReauthRequiredError } from "../../auth/oauth/errors.js";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { diagnose, isAuthenticationFailure } from "../diagnose.js";
import { testAccountConnection } from "../connection-test.js";

const ctx = { protocol: "imap" as const, host: "mail.example.com", port: 993 };
const passwordProvider = {
  imapAuth: async () => ({ user: "max@example.com", pass: "pw" }),
  smtpAuth: async () => ({ user: "max@example.com", pass: "pw" }),
  invalidate: async () => {},
};

describe("diagnose", () => {
  it("explains imapflow login failures with the provider's app-password hint", () => {
    const err = Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "Invalid credentials" });
    const d = diagnose(err, { ...ctx, presetId: "gmail" });
    expect(d.code).toBe("auth_failed");
    expect(d.message.de).toMatch(/App-Passwort/);
    expect(d.message.en).toContain("https://support.google.com/accounts/answer/185833");
  });

  it("recognises Microsoft 365 with SMTP AUTH disabled", () => {
    const err = Object.assign(new Error("Invalid login"), {
      code: "EAUTH",
      response: "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.",
    });
    expect(diagnose(err, { ...ctx, protocol: "smtp", port: 587 }).code).toBe("smtp_auth_disabled");
  });

  it("recognises Microsoft basic-auth retirement", () => {
    const err = Object.assign(new Error("Invalid login"), { code: "EAUTH", response: "535 5.7.139 Authentication unsuccessful, basic authentication is disabled." });
    expect(diagnose(err, ctx).code).toBe("basic_auth_disabled");
  });

  it("offers certificate pinning for self-signed certificates", () => {
    const err = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(diagnose(err, ctx)).toMatchObject({ code: "certificate_untrusted", offerCertificatePinning: true });
  });

  it("warns loudly about a changed pinned certificate", () => {
    expect(diagnose(new CertificatePinMismatchError("AA", "BB"), ctx).code).toBe("certificate_pin_mismatch");
  });

  it("refuses to suggest plaintext when STARTTLS is missing", () => {
    const err = Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true });
    const d = diagnose(err, { ...ctx, port: 143 });
    expect(d.code).toBe("starttls_missing");
    expect(d.message.en).toMatch(/port 993/);
  });

  it.each([
    ["ECONNREFUSED", "connection_refused"],
    ["ENOTFOUND", "host_not_found"],
    ["CONNECT_TIMEOUT", "timeout"],
    ["ETIMEDOUT", "timeout"],
  ])("maps %s to %s", (code, expected) => {
    expect(diagnose(Object.assign(new Error(code), { code }), ctx).code).toBe(expected);
  });

  it("recognises imapflow and nodemailer authentication errors", () => {
    expect(isAuthenticationFailure({ authenticationFailed: true })).toBe(true);
    expect(isAuthenticationFailure({ code: "EAUTH" })).toBe(true);
    expect(isAuthenticationFailure(new Error("timeout"))).toBe(false);
  });

  it("passes OAuth re-authentication errors through", () => {
    expect(diagnose(new OAuthReauthRequiredError("work", "revoked"), ctx).code).toBe("oauth_reauth");
  });
});

describe("testAccountConnection", () => {
  const account = AccountSchema.parse({
    id: "main",
    email: "max@example.com",
    imap: { host: "mail.example.com", port: 993 },
    smtp: { host: "mail.example.com", port: 465 },
  });

  it("reports capabilities including custom keyword support", async () => {
    const imap = new FakeImap();
    imap.addFolder("Sent", { specialUse: "\\Sent" });
    const report = await testAccountConnection(account, passwordProvider, {
      connectImap: async () => imap as never,
      verifySmtp: async () => {},
    });
    expect(report.imap).toMatchObject({ ok: true, folderCount: 2, capabilities: { uidplus: true, move: true, specialUse: true, customKeywords: true } });
    expect(report.smtp).toEqual({ ok: true });
  });

  it("detects servers without custom keywords (Exchange)", async () => {
    const imap = new FakeImap();
    imap.folders.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged"]);
    const report = await testAccountConnection(account, passwordProvider, { connectImap: async () => imap as never, verifySmtp: async () => {} });
    expect(report.imap.ok && report.imap.capabilities.customKeywords).toBe(false);
  });

  it("logs in only once when the password is wrong", async () => {
    let attempts = 0;
    const report = await testAccountConnection(account, passwordProvider, {
      presetId: "gmx",
      connectImap: async () => {
        attempts++;
        throw Object.assign(new Error("Command failed"), { authenticationFailed: true });
      },
      verifySmtp: async () => {},
    });
    expect(attempts).toBe(1);
    expect(report.imap.ok).toBe(false);
    if (!report.imap.ok) expect(report.imap.diagnosis.message.de).toMatch(/POP3\/IMAP Abruf/);
  });

  it("diagnoses SMTP failures separately", async () => {
    const report = await testAccountConnection(account, passwordProvider, {
      connectImap: async () => new FakeImap() as never,
      verifySmtp: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    });
    expect(report.imap.ok).toBe(true);
    expect(report.smtp).toMatchObject({ ok: false, diagnosis: { code: "connection_refused" } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/onboarding/__tests__/connection-test.test.ts`
Expected: FAIL — `Failed to resolve import "../diagnose.js"`.

- [ ] **Step 3: Implement**

`src/onboarding/diagnose.ts`:

```ts
import {
  OAuthAuthorizationError,
  OAuthConfigurationError,
  OAuthReauthRequiredError,
  OAuthSignInRequiredError,
  OAuthTokenError,
} from "../auth/oauth/errors.js";
import { SecretStoreUnavailableError } from "../secrets/keyring-store.js";
import { presetById, type LocalizedText } from "./presets.js";

/** imapflow sets `authenticationFailed`; nodemailer uses code "EAUTH". */
export function isAuthenticationFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { authenticationFailed?: unknown; code?: unknown };
  return e.authenticationFailed === true || e.code === "EAUTH";
}

export type DiagnosisCode =
  | "auth_failed"
  | "app_password_required"
  | "smtp_auth_disabled"
  | "basic_auth_disabled"
  | "certificate_untrusted"
  | "certificate_expired"
  | "certificate_hostname"
  | "certificate_pin_mismatch"
  | "starttls_missing"
  | "connection_refused"
  | "timeout"
  | "host_not_found"
  | "oauth_reauth"
  | "oauth_config"
  | "oauth_failed"
  | "keychain_unavailable"
  | "unknown";

export interface Diagnosis {
  code: DiagnosisCode;
  message: LocalizedText;
  /** The setup should offer to inspect and trust the server certificate. */
  offerCertificatePinning?: boolean;
}

export interface DiagnoseContext {
  protocol: "imap" | "smtp";
  host: string;
  port: number;
  presetId?: string;
}

const UNTRUSTED_CERT = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

function same(text: string): LocalizedText {
  return { de: text, en: text };
}

function serverText(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err);
  const e = err as { message?: unknown; response?: unknown; responseText?: unknown; serverResponseCode?: unknown };
  return [e.message, e.response, e.responseText, e.serverResponseCode].filter((x) => typeof x === "string").join(" ");
}

function authHint(ctx: DiagnoseContext): LocalizedText {
  const preset = ctx.presetId ? presetById(ctx.presetId) : undefined;
  const link = preset?.helpUrl ? ` ${preset.helpUrl}` : "";
  if (preset?.auth === "app-password") {
    return {
      de: `Anmeldung abgelehnt. ${preset.name} verlangt ein App-Passwort statt Ihres normalen Passworts.${link}`,
      en: `Login rejected. ${preset.name} requires an app password instead of your normal password.${link}`,
    };
  }
  if (preset && preset.notes.length > 0) {
    return {
      de: `Anmeldung abgelehnt. Bitte Benutzername und Passwort prüfen. Hinweis: ${preset.notes[0].de}${link}`,
      en: `Login rejected. Please check user name and password. Note: ${preset.notes[0].en}${link}`,
    };
  }
  return {
    de: "Anmeldung abgelehnt. Bitte Benutzername und Passwort prüfen. Manche Anbieter verlangen ein eigenes App-Passwort.",
    en: "Login rejected. Please check user name and password. Some providers require a separate app password.",
  };
}

/** Turn any connection or login error into a plain-language explanation with a next step. */
export function diagnose(err: unknown, ctx: DiagnoseContext): Diagnosis {
  const where = `${ctx.host}:${ctx.port}`;
  if (err instanceof OAuthReauthRequiredError || err instanceof OAuthSignInRequiredError) {
    return { code: "oauth_reauth", message: same(err.message) };
  }
  if (err instanceof OAuthConfigurationError) {
    return { code: "oauth_config", message: same(err.message) };
  }
  if (err instanceof OAuthAuthorizationError || err instanceof OAuthTokenError) {
    return { code: "oauth_failed", message: same(err.message) };
  }
  if (err instanceof SecretStoreUnavailableError) return { code: "keychain_unavailable", message: same(err.message) };

  const code = typeof err === "object" && err !== null ? String((err as { code?: unknown }).code ?? "") : "";
  const text = serverText(err);

  if (code === "ERR_CERT_PIN_MISMATCH") return { code: "certificate_pin_mismatch", message: same(text) };
  if (UNTRUSTED_CERT.has(code) || /self[- ]signed certificate/i.test(text)) {
    return {
      code: "certificate_untrusted",
      offerCertificatePinning: true,
      message: {
        de: `Das Zertifikat von ${where} ist nicht von einer bekannten Stelle signiert (typisch für eigene Server). Sie können es prüfen und gezielt vertrauen.`,
        en: `The certificate of ${where} is not signed by a known authority (typical for self-hosted servers). You can inspect it and trust exactly this certificate.`,
      },
    };
  }
  if (code === "CERT_HAS_EXPIRED") {
    return {
      code: "certificate_expired",
      message: {
        de: `Das Zertifikat von ${where} ist abgelaufen. Es muss auf dem Server erneuert werden.`,
        en: `The certificate of ${where} has expired and must be renewed on the server.`,
      },
    };
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return {
      code: "certificate_hostname",
      message: {
        de: `Das Zertifikat passt nicht zum Servernamen ${ctx.host}. Verwenden Sie den Servernamen aus der Anleitung Ihres Anbieters.`,
        en: `The certificate does not match the server name ${ctx.host}. Use the server name from your provider's instructions.`,
      },
    };
  }
  if ((err as { tlsFailed?: unknown })?.tlsFailed === true || code === "ETLS" || /does not support STARTTLS/i.test(text)) {
    return {
      code: "starttls_missing",
      message: {
        de: `${where} bietet keine Verschlüsselung (STARTTLS) an. Ohne Verschlüsselung würde das Passwort lesbar übertragen; versuchen Sie Port ${ctx.protocol === "imap" ? 993 : 465}.`,
        en: `${where} offers no encryption (STARTTLS). Without it the password would travel in clear text; try port ${ctx.protocol === "imap" ? 993 : 465}.`,
      },
    };
  }
  if (isAuthenticationFailure(err) || /authenticat|invalid credentials|login failed|535/i.test(text)) {
    if (/SmtpClientAuthentication is disabled/i.test(text)) {
      return {
        code: "smtp_auth_disabled",
        message: {
          de: "Microsoft 365 hat das Senden über SMTP für dieses Postfach deaktiviert. Ein Administrator muss „Authenticated SMTP“ aktivieren (siehe docs/guide/providers.md).",
          en: "Microsoft 365 has SMTP sending disabled for this mailbox. An administrator must enable Authenticated SMTP (see docs/guide/providers.md).",
        },
      };
    }
    if (/basic authentication is disabled|5\.7\.139/i.test(text)) {
      return {
        code: "basic_auth_disabled",
        message: {
          de: "Der Anbieter erlaubt keine Anmeldung mit Passwort mehr. Bitte die Microsoft-Anmeldung (OAuth) wählen.",
          en: "The provider no longer accepts password logins. Please choose the Microsoft sign-in (OAuth).",
        },
      };
    }
    if (/application-specific password required|5\.7\.9/i.test(text)) {
      return {
        code: "app_password_required",
        message: {
          de: "Der Anbieter verlangt ein App-Passwort. https://support.google.com/accounts/answer/185833",
          en: "The provider requires an app password. https://support.google.com/accounts/answer/185833",
        },
      };
    }
    return { code: "auth_failed", message: authHint(ctx) };
  }
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return {
      code: "connection_refused",
      message: {
        de: `${where} nimmt keine Verbindung an. Servername und Port prüfen; eine Firewall kann den Port blockieren.`,
        en: `${where} refuses the connection. Check server name and port; a firewall may block the port.`,
      },
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      code: "host_not_found",
      message: { de: `Den Server ${ctx.host} gibt es nicht (Tippfehler?).`, en: `The server ${ctx.host} does not exist (typo?).` },
    };
  }
  if (/TIMEOUT|ETIMEDOUT|ESOCKET/.test(code) || /timed? ?out/i.test(text)) {
    return {
      code: "timeout",
      message: {
        de: `${where} antwortet nicht. Servername, Port und Internetverbindung prüfen.`,
        en: `${where} does not answer. Check server name, port and your internet connection.`,
      },
    };
  }
  return { code: "unknown", message: same(text || "Unknown error") };
}
```

`src/onboarding/connection-test.ts`:

```ts
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { AccountConfig } from "../config/schema.js";
import type { AuthProvider, ImapAuth } from "../auth/provider.js";
import { imapSecurityOptions, pinFromEndpoint, smtpSecurityOptions } from "../connection-security.js";
import { diagnose, type Diagnosis } from "./diagnose.js";

export interface CapabilitySummary {
  specialUse: boolean;
  uidplus: boolean;
  move: boolean;
  idle: boolean;
  /** PERMANENTFLAGS contains \* — custom keywords like $Done can be stored. */
  customKeywords: boolean;
}

export type StepResult<T extends object = object> = ({ ok: true } & T) | { ok: false; diagnosis: Diagnosis; error: unknown };

export interface AccountTestReport {
  imap: StepResult<{ capabilities: CapabilitySummary; folderCount: number }>;
  /** Present when the account has SMTP configured. */
  smtp?: StepResult;
}

/** The part of ImapFlow the test needs (FakeImap satisfies it in tests). */
export interface ImapProbeClient {
  capabilities: Map<string, unknown>;
  mailbox: false | { permanentFlags?: Set<string> };
  list(): Promise<unknown[]>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  logout(): Promise<void>;
}

export interface ConnectionTestDeps {
  connectImap?(account: AccountConfig, auth: ImapAuth): Promise<ImapProbeClient>;
  verifySmtp?(account: AccountConfig, provider: AuthProvider): Promise<void>;
  /** Preset of the detected provider, used for provider-specific hints. */
  presetId?: string;
}

async function defaultConnectImap(account: AccountConfig, auth: ImapAuth): Promise<ImapProbeClient> {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    ...imapSecurityOptions(account.imap.host, account.imap.port, pinFromEndpoint(account.imap)),
    auth,
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  });
  await client.connect();
  return client;
}

async function defaultVerifySmtp(account: AccountConfig, provider: AuthProvider): Promise<void> {
  const endpoint = account.smtp!;
  const transport = nodemailer.createTransport({
    host: endpoint.host,
    port: endpoint.port,
    ...smtpSecurityOptions(endpoint.host, endpoint.port, pinFromEndpoint(endpoint)),
    auth: (await provider.smtpAuth()) as SMTPTransport.Options["auth"],
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

/**
 * Log in once to IMAP (list folders, read INBOX capabilities) and verify SMTP. No retries:
 * repeated failed logins can lock the mailbox. Nothing is changed on the server.
 */
export async function testAccountConnection(
  account: AccountConfig,
  provider: AuthProvider,
  deps: ConnectionTestDeps = {},
): Promise<AccountTestReport> {
  let imap: AccountTestReport["imap"];
  let client: ImapProbeClient | undefined;
  try {
    client = await (deps.connectImap ?? defaultConnectImap)(account, await provider.imapAuth());
    const folders = await client.list();
    const lock = await client.getMailboxLock("INBOX");
    let customKeywords: boolean;
    try {
      const permanent = client.mailbox ? client.mailbox.permanentFlags : undefined;
      customKeywords = !permanent || permanent.has("\\*");
    } finally {
      lock.release();
    }
    const has = (cap: string) => client!.capabilities.has(cap);
    imap = {
      ok: true,
      folderCount: folders.length,
      capabilities: { specialUse: has("SPECIAL-USE"), uidplus: has("UIDPLUS"), move: has("MOVE"), idle: has("IDLE"), customKeywords },
    };
  } catch (error) {
    imap = { ok: false, error, diagnosis: diagnose(error, { protocol: "imap", host: account.imap.host, port: account.imap.port, presetId: deps.presetId }) };
  } finally {
    await client?.logout().catch(() => {});
  }

  if (!account.smtp) return { imap };
  let smtp: StepResult;
  try {
    await (deps.verifySmtp ?? defaultVerifySmtp)(account, provider);
    smtp = { ok: true };
  } catch (error) {
    smtp = { ok: false, error, diagnosis: diagnose(error, { protocol: "smtp", host: account.smtp.host, port: account.smtp.port, presetId: deps.presetId }) };
  }
  return { imap, smtp };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/onboarding/__tests__/connection-test.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/diagnose.ts src/onboarding/connection-test.ts src/onboarding/__tests__/connection-test.test.ts
git commit -m "feat(onboarding): connection test with plain-language diagnosis

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: CLI prompts and German/English texts

**Files:**
- Create: `src/cli/messages.ts`, `src/cli/prompt.ts`
- Test: `src/cli/__tests__/prompt.test.ts`

**Interfaces:**
- Produces:
  - `type Locale = "de" | "en"`, `detectLocale(env?)`, `type MessageKey`, `t(locale, key, vars?)`
  - `interface Choice<T extends string> { value: T; label: string }`, `interface Prompter { text; secret; confirm; select; print; close }`, `class PromptCancelledError`
  - `interface SecretInputState { value; done; cancelled }`, `applySecretInput(state, chunk): { state; echo }`
  - `createTerminalPrompter(locale, input?, output?): Prompter`

- [ ] **Step 1: Write the failing tests**

`src/cli/__tests__/prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { applySecretInput, createTerminalPrompter } from "../prompt.js";
import { detectLocale, t } from "../messages.js";

const empty = { value: "", done: false, cancelled: false };

describe("applySecretInput (hidden password entry)", () => {
  it("echoes stars, never the characters", () => {
    const r = applySecretInput(empty, "s3cr3t");
    expect(r.state.value).toBe("s3cr3t");
    expect(r.echo).toBe("******");
  });

  it("handles backspace, Enter and pasted text with a trailing newline", () => {
    let r = applySecretInput(empty, "abc\u007f");
    expect(r.state.value).toBe("ab");
    r = applySecretInput(r.state, "Pässwörd!\r");
    expect(r.state).toEqual({ value: "abPässwörd!", done: true, cancelled: false });
  });

  it("cancels on Ctrl+C and drops what was typed", () => {
    expect(applySecretInput({ ...empty, value: "abc" }, "\u0003").state).toEqual({ value: "", done: false, cancelled: true });
  });

  it("ignores arrow keys", () => {
    expect(applySecretInput({ ...empty, value: "x" }, "\u001b[A").state.value).toBe("x");
  });
});

describe("terminal prompter with piped input", () => {
  it("reads consecutive answers, applies defaults and validation", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    (input as unknown as PassThrough).end("\nnot-a-port\n587\nj\n2\n");
    const p = createTerminalPrompter("de", input, output);
    expect(await p.text("Host", { default: "imap.web.de" })).toBe("imap.web.de");
    expect(await p.text("Port", { validate: (v) => (/^\d+$/.test(v) ? undefined : "Zahl!") })).toBe("587");
    expect(await p.confirm("Weiter?", false)).toBe(true);
    expect(await p.select("Wahl", [{ value: "a", label: "A" }, { value: "b", label: "B" }])).toBe("b");
    p.close();
  });
});

describe("messages", () => {
  it("interpolates and localises", () => {
    expect(t("de", "detected", { name: "GMX" })).toBe("Erkannt: GMX");
    expect(t("en", "detected", { name: "GMX" })).toBe("Detected: GMX");
  });

  it("detects the locale from IMAP_MCP_LANG, then LANG", () => {
    expect(detectLocale({ IMAP_MCP_LANG: "en", LANG: "de_AT.UTF-8" })).toBe("en");
    expect(detectLocale({ LANG: "de_AT.UTF-8" })).toBe("de");
    expect(detectLocale({ LANG: "en_US.UTF-8" })).toBe("en");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/prompt.test.ts`
Expected: FAIL — `Failed to resolve import "../prompt.js"`.

- [ ] **Step 3: Implement**

`src/cli/messages.ts`:

```ts
export type Locale = "de" | "en";

/** IMAP_MCP_LANG wins; otherwise LANG/LC_ALL, then the OS locale. */
export function detectLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const explicit = env.IMAP_MCP_LANG?.toLowerCase();
  if (explicit === "de" || explicit === "en") return explicit;
  const fromEnv = (env.LC_ALL || env.LANG || "").toLowerCase();
  if (fromEnv) return fromEnv.startsWith("de") ? "de" : "en";
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("de") ? "de" : "en";
}

const MESSAGES = {
  welcome: { de: "=== E-Mail für Claude einrichten ===", en: "=== Set up email for Claude ===" },
  envMode: {
    de: "Hinweis: Diese Installation wird über Umgebungsvariablen (z. B. Claude-Desktop-Erweiterung) konfiguriert. Das Setup bearbeitet ~/.imap-mcp/config.json.",
    en: "Note: this installation is configured through environment variables (e.g. the Claude Desktop extension). Setup edits ~/.imap-mcp/config.json.",
  },
  menu: { de: "Was möchten Sie tun?", en: "What would you like to do?" },
  menuAdd: { de: "Postfach hinzufügen", en: "Add a mailbox" },
  menuRemove: { de: "Postfach entfernen", en: "Remove a mailbox" },
  menuReauth: { de: "Neu anmelden (Microsoft/Google)", en: "Sign in again (Microsoft/Google)" },
  menuDone: { de: "Fertig", en: "Done" },
  chooseAccount: { de: "Welches Postfach?", en: "Which mailbox?" },
  askEmail: { de: "E-Mail-Adresse", en: "Email address" },
  invalidEmail: { de: "Das ist keine gültige E-Mail-Adresse.", en: "That is not a valid email address." },
  detecting: { de: "Suche die Servereinstellungen …", en: "Looking up the server settings …" },
  detected: { de: "Erkannt: {name}", en: "Detected: {name}" },
  serverLine: { de: "  {protocol}: {host}:{port}", en: "  {protocol}: {host}:{port}" },
  helpLink: { de: "Anleitung: {url}", en: "Instructions: {url}" },
  useDetected: { de: "Diese Einstellungen verwenden?", en: "Use these settings?" },
  askImapHost: { de: "IMAP-Server", en: "IMAP server" },
  askImapPort: { de: "IMAP-Port", en: "IMAP port" },
  askSmtpHost: { de: "SMTP-Server", en: "SMTP server" },
  askSmtpPort: { de: "SMTP-Port", en: "SMTP port" },
  invalidPort: { de: "Bitte eine Zahl zwischen 1 und 65535 eingeben.", en: "Please enter a number between 1 and 65535." },
  askAuthMethod: { de: "Wie möchten Sie sich anmelden?", en: "How do you want to sign in?" },
  authOAuth: { de: "Mit {provider}-Konto im Browser (empfohlen)", en: "With your {provider} account in the browser (recommended)" },
  authPassword: { de: "Mit (App-)Passwort", en: "With an (app) password" },
  askAccountId: { de: "Kurzname für dieses Postfach", en: "Short name for this mailbox" },
  invalidAccountId: {
    de: "Nur Kleinbuchstaben, Ziffern und Bindestrich (max. 32), noch nicht vergeben.",
    en: "Lowercase letters, digits and dashes only (max. 32), not yet in use.",
  },
  askDisplayName: { de: "Absendername (z. B. Max Mustermann, leer = keiner)", en: "Sender name (e.g. Jane Doe, empty = none)" },
  askPassword: { de: "Passwort (wird nicht angezeigt)", en: "Password (hidden)" },
  askAppPassword: { de: "App-Passwort (wird nicht angezeigt)", en: "App password (hidden)" },
  askClientId: { de: "Anwendungs-ID (Client-ID) der App-Registrierung", en: "Application (client) ID of the app registration" },
  askTenant: { de: "Mandant (Domain oder ID, leer = beliebige Organisation)", en: "Tenant (domain or ID, empty = any organisation)" },
  askGoogleClientId: { de: "Google OAuth Client-ID", en: "Google OAuth client ID" },
  askGoogleSecret: { de: "Google OAuth Client-Secret (wird nicht angezeigt)", en: "Google OAuth client secret (hidden)" },
  askSignInMode: { de: "Wo melden Sie sich an?", en: "Where do you sign in?" },
  signInBrowser: { de: "Im Browser auf diesem Computer", en: "In the browser on this computer" },
  signInCode: { de: "Mit einem Code auf einem anderen Gerät", en: "With a code on another device" },
  signedIn: { de: "Angemeldet.", en: "Signed in." },
  testing: { de: "Teste die Verbindung …", en: "Testing the connection …" },
  imapOk: {
    de: "✓ Empfangen (IMAP): verbunden, {folders} Ordner. Eigene Markierungen: {keywords}.",
    en: "✓ Receiving (IMAP): connected, {folders} folders. Custom labels: {keywords}.",
  },
  smtpOk: { de: "✓ Senden (SMTP): Anmeldung erfolgreich.", en: "✓ Sending (SMTP): login successful." },
  stepFailed: { de: "✗ {step}: {message}", en: "✗ {step}: {message}" },
  stepImap: { de: "Empfangen (IMAP)", en: "Receiving (IMAP)" },
  stepSmtp: { de: "Senden (SMTP)", en: "Sending (SMTP)" },
  yes: { de: "ja", en: "yes" },
  no: { de: "nein", en: "no" },
  certTitle: { de: "Zertifikat des Servers {host}:", en: "Certificate of server {host}:" },
  certDetails: {
    de: "  Ausgestellt für: {subject}\n  Aussteller: {issuer}\n  Gültig: {from} bis {to}\n  SHA-256: {fingerprint}",
    en: "  Issued to: {subject}\n  Issuer: {issuer}\n  Valid: {from} to {to}\n  SHA-256: {fingerprint}",
  },
  certTrust: {
    de: "Diesem Zertifikat vertrauen? Nur bestätigen, wenn es Ihr eigener Server ist und der Fingerabdruck stimmt.",
    en: "Trust this certificate? Only confirm if this is your own server and the fingerprint is correct.",
  },
  retryPassword: { de: "Passwort erneut eingeben?", en: "Enter the password again?" },
  saveAnyway: { de: "Trotzdem speichern?", en: "Save anyway?" },
  permIntro: {
    de: "Was darf Claude mit diesem Postfach tun? (Später änderbar.)",
    en: "What may Claude do with this mailbox? (Can be changed later.)",
  },
  permRead: { de: "E-Mails lesen und suchen", en: "Read and search emails" },
  permWrite: { de: "Ordnen, markieren, Entwürfe anlegen", en: "Organise, flag, create drafts" },
  permSend: {
    de: "Selbst E-Mails senden (empfohlen: nein – Claude schreibt Entwürfe, Sie senden)",
    en: "Send emails itself (recommended: no – Claude writes drafts, you send)",
  },
  permDelete: { de: "E-Mails löschen", en: "Delete emails" },
  saved: { de: "Gespeichert. Passwörter liegen im Schlüsselbund des Betriebssystems.", en: "Saved. Secrets are stored in the operating system's keychain." },
  nextSteps: {
    de: "Nächster Schritt: Claude Desktop neu starten. Prüfen jederzeit mit: imap-mcp-setup doctor",
    en: "Next step: restart Claude Desktop. Check any time with: imap-mcp-setup doctor",
  },
  removed: { de: "Postfach „{id}“ entfernt.", en: 'Mailbox "{id}" removed.' },
  cannotRemoveLast: {
    de: "Das letzte Postfach kann nicht entfernt werden. Zum Zurücksetzen den Ordner ~/.imap-mcp löschen.",
    en: "The last mailbox cannot be removed. To reset, delete the folder ~/.imap-mcp.",
  },
  noOAuthAccounts: { de: "Kein Postfach verwendet eine Microsoft- oder Google-Anmeldung.", en: "No mailbox uses a Microsoft or Google sign-in." },
  cancelled: { de: "Abgebrochen. Nichts wurde gespeichert.", en: "Cancelled. Nothing was saved." },
  doctorTitle: { de: "=== Prüfung der E-Mail-Einrichtung ===", en: "=== Email setup check ===" },
  configOk: { de: "✓ Konfiguration geladen ({count} Postfach/Postfächer)", en: "✓ Configuration loaded ({count} mailbox(es))" },
  configFailed: { de: "✗ Konfiguration: {message}", en: "✗ Configuration: {message}" },
  runSetup: { de: "  → Einrichten mit: imap-mcp-setup", en: "  → Set up with: imap-mcp-setup" },
  secretOk: { de: "✓ Zugangsdaten gespeichert", en: "✓ Credentials stored" },
  secretMissing: {
    de: "✗ Keine Zugangsdaten gespeichert → imap-mcp-setup ausführen und das Postfach neu anlegen",
    en: "✗ No credentials stored → run imap-mcp-setup and add the mailbox again",
  },
  secretFailed: { de: "✗ Zugangsdaten: {message}", en: "✗ Credentials: {message}" },
  tlsImplicit: { de: "• {protocol}: verschlüsselt (TLS, Port {port})", en: "• {protocol}: encrypted (TLS, port {port})" },
  tlsStartTls: { de: "• {protocol}: verschlüsselt (STARTTLS verpflichtend, Port {port})", en: "• {protocol}: encrypted (mandatory STARTTLS, port {port})" },
  tlsPinned: { de: "• {protocol}: verschlüsselt, festgelegtes Zertifikat {fingerprint}", en: "• {protocol}: encrypted, pinned certificate {fingerprint}" },
  tlsLoopback: {
    de: "• {protocol}: lokale Verbindung {host}:{port} (Verschlüsselung optional)",
    en: "• {protocol}: local connection {host}:{port} (encryption optional)",
  },
  smtpMissing: { de: "• Senden: kein SMTP-Server eingetragen", en: "• Sending: no SMTP server configured" },
  permissionsLine: { de: "• Rechte: {list}", en: "• Permissions: {list}" },
  doctorOk: { de: "Alles in Ordnung.", en: "Everything is fine." },
  doctorProblems: { de: "{count} Problem(e) gefunden.", en: "{count} problem(s) found." },
  accountsEmpty: { de: "Keine Postfächer eingerichtet.", en: "No mailboxes configured." },
  usage: {
    de:
      "Verwendung:\n" +
      "  imap-mcp-setup [setup]                     Postfach einrichten, ändern oder entfernen\n" +
      "  imap-mcp-setup doctor                      Einrichtung prüfen (Exit-Code 1 bei Problemen)\n" +
      "  imap-mcp-setup accounts list               Eingerichtete Postfächer anzeigen\n" +
      "  imap-mcp-setup accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]\n" +
      "                                             Microsoft-/Google-Anmeldung (erneut) durchführen",
    en:
      "Usage:\n" +
      "  imap-mcp-setup [setup]                     Add, change or remove mailboxes\n" +
      "  imap-mcp-setup doctor                      Check the setup (exit code 1 on problems)\n" +
      "  imap-mcp-setup accounts list               Show the configured mailboxes\n" +
      "  imap-mcp-setup accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]\n" +
      "                                             Sign in (again) to Microsoft/Google",
  },
  loginUnknownAccount: {
    de: "Es gibt kein Postfach „{id}“. Vorhanden: {ids}.",
    en: 'There is no mailbox "{id}". Configured: {ids}.',
  },
  loginNotOAuth: {
    de: "Das Postfach „{id}“ meldet sich mit Passwort an; eine Anmeldung im Browser ist nicht nötig. Passwort ändern: imap-mcp-setup",
    en: 'The mailbox "{id}" signs in with a password; no browser sign-in is needed. To change the password: imap-mcp-setup',
  },
  loginNoDeviceCode: {
    de: "{provider} bietet keine Anmeldung mit Code. Verwenden Sie --no-browser und öffnen Sie den angezeigten Link.",
    en: "{provider} offers no sign-in with a code. Use --no-browser and open the link that is shown.",
  },
  loginSuccess: { de: "✓ Angemeldet: {email}. Die Anmeldung ist gespeichert.", en: "✓ Signed in: {email}. The sign-in has been saved." },
  loginFailed: { de: "✗ Anmeldung fehlgeschlagen: {message}", en: "✗ Sign-in failed: {message}" },
} satisfies Record<string, { de: string; en: string }>;

export type MessageKey = keyof typeof MESSAGES;

export function t(locale: Locale, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return MESSAGES[key][locale].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
```

`src/cli/prompt.ts`:

```ts
import * as readline from "node:readline";
import type { Locale } from "./messages.js";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

export interface Prompter {
  text(question: string, opts?: { default?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  secret(question: string): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(question: string, choices: Choice<T>[], defaultValue?: T): Promise<T>;
  print(line?: string): void;
  close(): void;
}

export class PromptCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "PromptCancelledError";
  }
}

export interface SecretInputState {
  value: string;
  done: boolean;
  cancelled: boolean;
}

/**
 * Keystroke handling for hidden input (pure, so it can be tested without a terminal).
 * Each typed character is echoed as "*"; Backspace removes one; Enter finishes; Ctrl+C cancels;
 * escape sequences (arrow keys) are ignored.
 */
export function applySecretInput(state: SecretInputState, chunk: string): { state: SecretInputState; echo: string } {
  if (chunk.startsWith("\u001b")) return { state, echo: "" };
  let value = state.value;
  let echo = "";
  for (const ch of chunk) {
    if (ch === "\r" || ch === "\n") return { state: { value, done: true, cancelled: false }, echo: echo + "\n" };
    if (ch === "\u0003") return { state: { value: "", done: false, cancelled: true }, echo: echo + "\n" };
    if (ch === "\u007f" || ch === "\b") {
      if (value.length > 0) {
        value = Array.from(value).slice(0, -1).join("");
        echo += "\b \b";
      }
      continue;
    }
    if (ch < " ") continue;
    value += ch;
    echo += "*";
  }
  return { state: { value, done: false, cancelled: false }, echo };
}

const YES = new Set(["y", "yes", "j", "ja"]);
const NO = new Set(["n", "no", "nein"]);

export function createTerminalPrompter(
  locale: Locale,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Prompter {
  const interactive = input.isTTY === true;
  let shared: readline.Interface | undefined;
  let lines: AsyncIterator<string> | undefined;

  async function line(question: string): Promise<string> {
    if (!interactive) {
      // Piped input (scripts, CI): one shared reader so buffered lines are not lost.
      output.write(question);
      shared ??= readline.createInterface({ input, terminal: false });
      lines ??= shared[Symbol.asyncIterator]();
      const next = await lines.next();
      output.write("\n");
      if (next.done) throw new PromptCancelledError();
      return next.value;
    }
    const rl = readline.createInterface({ input, output, terminal: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        rl.once("SIGINT", () => reject(new PromptCancelledError()));
        rl.question(question, resolve);
      });
    } finally {
      rl.close();
    }
  }

  async function hidden(question: string): Promise<string> {
    if (!interactive) return line(question);
    output.write(question);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    return new Promise<string>((resolve, reject) => {
      let state: SecretInputState = { value: "", done: false, cancelled: false };
      const onData = (chunk: string) => {
        const next = applySecretInput(state, chunk);
        state = next.state;
        output.write(next.echo);
        if (!state.done && !state.cancelled) return;
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        if (state.cancelled) reject(new PromptCancelledError());
        else resolve(state.value);
      };
      input.on("data", onData);
    });
  }

  return {
    async text(question, opts = {}) {
      for (;;) {
        const suffix = opts.default ? ` [${opts.default}]` : "";
        const answer = (await line(`${question}${suffix}: `)).trim() || opts.default || "";
        const problem = opts.validate?.(answer);
        if (!problem) return answer;
        output.write(`  ${problem}\n`);
      }
    },
    secret: (question) => hidden(`${question}: `),
    async confirm(question, defaultValue) {
      const hint = locale === "de" ? (defaultValue ? "J/n" : "j/N") : defaultValue ? "Y/n" : "y/N";
      for (;;) {
        const answer = (await line(`${question} (${hint}): `)).trim().toLowerCase();
        if (answer === "") return defaultValue;
        if (YES.has(answer)) return true;
        if (NO.has(answer)) return false;
      }
    },
    async select(question, choices, defaultValue) {
      output.write(`${question}\n`);
      choices.forEach((c, i) => output.write(`  ${i + 1}) ${c.label}\n`));
      const defaultIndex = Math.max(0, choices.findIndex((c) => c.value === defaultValue));
      for (;;) {
        const answer = (await line(`> [${defaultIndex + 1}] `)).trim();
        if (answer === "") return choices[defaultIndex].value;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
      }
    },
    print: (text = "") => output.write(`${text}\n`),
    close: () => shared?.close(),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/prompt.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Manual check of the hidden prompt (real terminal)**

```bash
npm run build
node -e "import('./dist/cli/prompt.js').then(async m => { const p = m.createTerminalPrompter('de'); const s = await p.secret('Passwort'); console.log('Länge:', s.length); p.close(); })"
```

Type `Größe`, press Backspace once, press Enter. Expected: only `*` characters appear, then `Länge: 4`. Repeat and press Ctrl+C: the process ends without printing a length. Do this in Windows Terminal and in one macOS/Linux terminal.

- [ ] **Step 6: Commit**

```bash
git add src/cli/messages.ts src/cli/prompt.ts src/cli/__tests__/prompt.test.ts
git commit -m "feat(cli): hidden password input and German/English prompt texts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Setup wizard

**Files:**
- Create: `src/cli/setup.ts`
- Create: `src/__tests__/helpers/scripted-prompter.ts`
- Test: `src/cli/__tests__/setup.test.ts`

**Interfaces:**
- Consumes: `AccountSchema`, `ConfigSchema`, `AccountConfig`, `AppConfig` (Plan 2); `OAuthAuthProvider` (Task 7); `MICROSOFT_DEFAULT_CLIENT_ID`, `microsoftProfile`, `googleProfile`, `OAuthProfile` (Task 4); `MemorySecretStore`, `StoredSecret` (Task 1); `DetectedProvider`, `detectProvider` (Task 9); `CertificateInfo`, `ProbeOptions` (Task 6); `AccountTestReport`, `Diagnosis` (Task 10); `t`, `Locale`, `Prompter`, `PromptCancelledError` (Task 11); `selfSignedCert` (Task 6).
- Produces:
  - `interface SetupDeps { prompter; locale; loadExisting(); save(config, secrets: StoredSecret[], removedAccountIds: string[]); detect(email); test(account, provider, presetId?); probe(opts); authorize(profile, mode, loginHint); envMode? }`
  - `runSetup(deps): Promise<number>` (0 ok, 1 not saved, 130 cancelled), `suggestAccountId(email, taken): string`
  - Test helper `scriptedPrompter(answers): Prompter & { output: string[]; asked: string[] }`

- [ ] **Step 1: Write the scripted prompter and the failing tests**

`src/__tests__/helpers/scripted-prompter.ts`:

```ts
import type { Choice, Prompter } from "../../cli/prompt.js";

/**
 * Prompter that answers from a script. "" means "accept the default".
 * `asked` records every question so tests can assert the dialogue.
 */
export function scriptedPrompter(answers: Array<string | boolean>): Prompter & { output: string[]; asked: string[] } {
  const queue = [...answers];
  const output: string[] = [];
  const asked: string[] = [];
  const next = (question: string) => {
    asked.push(question);
    if (queue.length === 0) throw new Error(`Scripted prompter ran out of answers at: ${question}`);
    return queue.shift()!;
  };
  return {
    output,
    asked,
    async text(question, opts = {}) {
      const answer = String(next(question)) || opts.default || "";
      const problem = opts.validate?.(answer);
      if (problem) throw new Error(`Scripted answer "${answer}" rejected for "${question}": ${problem}`);
      return answer;
    },
    async secret(question) {
      return String(next(question));
    },
    async confirm(question, defaultValue) {
      const answer = next(question);
      return answer === "" ? defaultValue : Boolean(answer);
    },
    async select<T extends string>(question: string, choices: Choice<T>[], defaultValue?: T): Promise<T> {
      const answer = String(next(question)) || defaultValue || choices[0].value;
      const hit = choices.find((c) => c.value === answer);
      if (!hit) throw new Error(`Scripted answer "${answer}" is not a choice of "${question}"`);
      return hit.value;
    },
    print: (line = "") => output.push(line),
    close: () => {},
  };
}
```

`src/cli/__tests__/setup.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { ConfigSchema, type AccountConfig, type AppConfig } from "../../config/schema.js";
import type { AuthProvider } from "../../auth/provider.js";
import { OAuthAuthProvider } from "../../auth/oauth/provider.js";
import { detectProvider, type DetectedProvider } from "../../onboarding/autoconfig.js";
import type { AccountTestReport } from "../../onboarding/connection-test.js";
import type { Diagnosis } from "../../onboarding/diagnose.js";
import type { StoredSecret } from "../../secrets/memory-store.js";
import { scriptedPrompter } from "../../__tests__/helpers/scripted-prompter.js";
import { selfSignedCert, type SelfSignedCert } from "../../__tests__/helpers/tls-fixtures.js";

let cert: SelfSignedCert;
beforeAll(async () => {
  cert = await selfSignedCert("mail.firma.example");
});
import { runSetup, suggestAccountId, type SetupDeps } from "../setup.js";

const OK: AccountTestReport = {
  imap: { ok: true, folderCount: 7, capabilities: { specialUse: true, uidplus: true, move: true, idle: true, customKeywords: true } },
  smtp: { ok: true },
};

function failing(step: "imap" | "smtp", diagnosis: Diagnosis): AccountTestReport {
  return step === "imap" ? { ...OK, imap: { ok: false, diagnosis, error: new Error(diagnosis.code) } } : { ...OK, smtp: { ok: false, diagnosis, error: new Error(diagnosis.code) } };
}

function harness(opts: {
  answers: Array<string | boolean>;
  existing?: AppConfig;
  detected?: DetectedProvider;
  reports?: AccountTestReport[];
}) {
  const saved: Array<{ config: AppConfig; secrets: StoredSecret[]; removed: string[] }> = [];
  const tested: Array<{ account: AccountConfig; auth: unknown }> = [];
  const reports = [...(opts.reports ?? [OK])];
  const prompter = scriptedPrompter(opts.answers);
  const deps: SetupDeps = {
    prompter,
    locale: "de",
    loadExisting: async () => opts.existing,
    save: async (config, secrets, removed) => {
      saved.push({ config, secrets, removed });
    },
    detect: async (email) => opts.detected ?? detectProvider(email, { network: false }),
    test: async (account: AccountConfig, provider: AuthProvider) => {
      // never let an OAuth provider talk to the real token endpoint from a unit test
      tested.push({ account, auth: provider instanceof OAuthAuthProvider ? "oauth" : await provider.imapAuth() });
      return reports.shift() ?? OK;
    },
    probe: async () => ({
      pem: cert.cert,
      fingerprint256: cert.fingerprint256,
      subject: "CN=mail.firma.example",
      issuer: "CN=mail.firma.example",
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2036-01-01T00:00:00.000Z",
      selfSigned: true,
      trusted: false,
      hostnameMatches: true,
    }),
    authorize: async () => ({ refreshToken: "refresh-123" }),
  };
  return { deps, saved, tested, prompter };
}

const selfHosted: DetectedProvider = {
  name: "firma.example",
  imap: { host: "mail.firma.example", port: 143, security: "starttls" },
  smtp: { host: "mail.firma.example", port: 587, security: "starttls" },
  auth: "password",
  usernameStyle: "address",
  notes: [],
  source: "autoconfig",
};

describe("runSetup — first account", () => {
  it("sets up a WEB.DE mailbox with hidden password, local-part login and safe default permissions", async () => {
    const { deps, saved, tested, prompter } = harness({
      // email, use detected, id, display name, password, read, write, send, delete
      answers: ["max@web.de", "", "", "Max Achleitner", "geheim", "", "", "", ""],
    });
    expect(await runSetup(deps)).toBe(0);
    expect(tested[0].auth).toEqual({ user: "max", pass: "geheim" });
    const account = saved[0].config.accounts[0];
    expect(account).toMatchObject({
      id: "main",
      email: "max@web.de",
      imap: { host: "imap.web.de", port: 993 },
      smtp: { host: "smtp.web.de", port: 587 },
      auth: { type: "password", username: "max" },
      identities: [{ email: "max@web.de", name: "Max Achleitner" }],
      permissions: { read: true, write: true, send: false, delete: false },
    });
    expect(saved[0].secrets).toEqual([{ accountId: "main", key: "password", value: "geheim" }]);
    expect(prompter.output.join("\n")).toContain("POP3/IMAP Abruf");
    expect(JSON.stringify(saved[0].config)).not.toContain("geheim");
  });

  it("pins a self-signed certificate only after the user confirms it", async () => {
    const untrusted: Diagnosis = { code: "certificate_untrusted", offerCertificatePinning: true, message: { de: "selbst signiert", en: "self-signed" } };
    const { deps, saved, tested, prompter } = harness({
      detected: selfHosted,
      reports: [failing("imap", untrusted), OK],
      answers: ["max@firma.example", "", "", "", "pw", true, "", "", "", ""],
    });
    expect(await runSetup(deps)).toBe(0);
    expect(tested).toHaveLength(2);
    expect(saved[0].config.accounts[0].imap).toMatchObject({
      host: "mail.firma.example",
      tlsFingerprint256: cert.fingerprint256,
      tlsCertificatePem: cert.cert,
    });
    expect(prompter.output.join("\n")).toContain(`SHA-256: ${cert.fingerprint256}`);
  });

  it("does not save when the user refuses to trust the certificate", async () => {
    const untrusted: Diagnosis = { code: "certificate_untrusted", offerCertificatePinning: true, message: { de: "x", en: "x" } };
    const { deps, saved } = harness({
      detected: selfHosted,
      reports: [failing("imap", untrusted)],
      // … trust? no, save anyway? no
      answers: ["max@firma.example", "", "", "", "pw", false, false],
    });
    expect(await runSetup(deps)).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it("asks for the password again after a rejected login", async () => {
    const rejected: Diagnosis = { code: "auth_failed", message: { de: "abgelehnt", en: "rejected" } };
    const { deps, saved, tested } = harness({
      reports: [failing("imap", rejected), OK],
      answers: ["max@gmx.at", "", "", "", "falsch", true, "richtig", "", "", "", ""],
    });
    expect(await runSetup(deps)).toBe(0);
    expect(tested.map((x) => x.auth)).toEqual([{ user: "max@gmx.at", pass: "falsch" }, { user: "max@gmx.at", pass: "richtig" }]);
    expect(saved[0].secrets).toEqual([{ accountId: "main", key: "password", value: "richtig" }]);
  });

  it("signs in to Microsoft 365 with OAuth and stores only the refresh token", async () => {
    const m365 = await detectProvider("office@firma.at", {
      resolveMx: async () => [{ exchange: "firma-at.mail.protection.outlook.com", priority: 0 }],
      fetch: async () => ({ status: 404, text: async () => "" }),
    });
    const { deps, saved, prompter } = harness({
      detected: m365,
      // email, use detected, auth method, id, name, client id, tenant, sign-in mode, perms ×4
      answers: ["office@firma.at", "", "oauth", "", "", "11111111-2222-3333-4444-555555555555", "firma.at", "browser", "", "", "", ""],
    });
    expect(await runSetup(deps)).toBe(0);
    expect(saved[0].config.accounts[0].auth).toEqual({
      type: "oauth2",
      provider: "microsoft",
      clientId: "11111111-2222-3333-4444-555555555555",
      tenant: "firma.at",
    });
    expect(saved[0].secrets).toEqual([{ accountId: "main", key: "oauthRefreshToken", value: "refresh-123" }]);
    expect(prompter.asked.some((q) => q.includes("Client-ID"))).toBe(true);
  });
});

describe("runSetup — existing configuration", () => {
  const existing = ConfigSchema.parse({
    version: 2,
    accounts: [
      { id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } },
      { id: "work", email: "max@firma.at", imap: { host: "outlook.office365.com", port: 993 }, auth: { type: "oauth2", provider: "microsoft", clientId: "c" } },
    ],
  });

  it("removes an account and its secrets", async () => {
    const { deps, saved } = harness({ existing, answers: ["remove", "work", true, "done"] });
    expect(await runSetup(deps)).toBe(0);
    expect(saved[0].config.accounts.map((a) => a.id)).toEqual(["main"]);
    expect(saved[0].removed).toEqual(["work"]);
  });

  it("re-runs the Microsoft sign-in for an OAuth account", async () => {
    const { deps, saved } = harness({ existing, answers: ["reauth", "work", "browser", "done"] });
    expect(await runSetup(deps)).toBe(0);
    expect(saved[0].secrets).toEqual([{ accountId: "work", key: "oauthRefreshToken", value: "refresh-123" }]);
  });

  it("suggests unique account ids", () => {
    expect(suggestAccountId("a@web.de", new Set())).toBe("main");
    expect(suggestAccountId("a@firma.at", new Set(["main", "firma-at"]))).toBe("firma-at-2");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/setup.test.ts`
Expected: FAIL — `Failed to resolve import "../setup.js"`.

- [ ] **Step 3: Implement the wizard**

`src/cli/setup.ts`:

```ts
import { AccountSchema, ConfigSchema, type AccountConfig, type AppConfig } from "../config/schema.js";
import type { AuthProvider } from "../auth/provider.js";
import { OAuthAuthProvider } from "../auth/oauth/provider.js";
import { MICROSOFT_DEFAULT_CLIENT_ID, googleProfile, microsoftProfile, type OAuthProfile } from "../auth/oauth/profiles.js";
import { MemorySecretStore, type StoredSecret } from "../secrets/memory-store.js";
import type { DetectedProvider } from "../onboarding/autoconfig.js";
import type { CertificateInfo, ProbeOptions } from "../onboarding/cert-probe.js";
import type { AccountTestReport } from "../onboarding/connection-test.js";
import type { Diagnosis } from "../onboarding/diagnose.js";
import { t, type Locale } from "./messages.js";
import { PromptCancelledError, type Prompter } from "./prompt.js";

export interface SetupDeps {
  prompter: Prompter;
  locale: Locale;
  /** The current config file, or undefined when none exists yet. */
  loadExisting(): Promise<AppConfig | undefined>;
  /** Write secrets first, then the config; delete the secrets of removed accounts. */
  save(config: AppConfig, secrets: StoredSecret[], removedAccountIds: string[]): Promise<void>;
  detect(email: string): Promise<DetectedProvider>;
  test(account: AccountConfig, provider: AuthProvider, presetId?: string): Promise<AccountTestReport>;
  probe(opts: ProbeOptions): Promise<CertificateInfo>;
  authorize(profile: OAuthProfile, mode: "browser" | "code", loginHint: string): Promise<{ refreshToken: string }>;
  /** Server is configured through IMAP_MCP_* environment variables (MCPB bundle). */
  envMode?: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function suggestAccountId(email: string, taken: Set<string>): string {
  if (!taken.has("main")) return "main";
  const base =
    (email.split("@")[1] ?? "mail").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "mail";
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

function portProblem(locale: Locale) {
  return (value: string) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : t(locale, "invalidPort");
  };
}

function staticPasswordProvider(user: string, password: string): AuthProvider {
  return {
    imapAuth: async () => ({ user, pass: password }),
    smtpAuth: async () => ({ user, pass: password }),
    invalidate: async () => {},
  };
}

interface Failure {
  step: "imap" | "smtp";
  diagnosis: Diagnosis;
}

function failures(report: AccountTestReport): Failure[] {
  const out: Failure[] = [];
  if (!report.imap.ok) out.push({ step: "imap", diagnosis: report.imap.diagnosis });
  if (report.smtp && !report.smtp.ok) out.push({ step: "smtp", diagnosis: report.smtp.diagnosis });
  return out;
}

async function askPassword(deps: SetupDeps, account: AccountConfig, staged: MemorySecretStore, appPassword: boolean): Promise<AuthProvider> {
  let password = "";
  while (!password) password = await deps.prompter.secret(t(deps.locale, appPassword ? "askAppPassword" : "askPassword"));
  await staged.set(account.id, "password", password);
  const user = (account.auth.type === "password" ? account.auth.username : undefined) ?? account.email;
  return staticPasswordProvider(user, password);
}

async function askOAuthSettings(deps: SetupDeps, provider: "microsoft" | "google", detected: DetectedProvider) {
  const { prompter: p, locale } = deps;
  if (provider === "google") {
    const clientId = await p.text(t(locale, "askGoogleClientId"), {
      validate: (v) => (v.endsWith(".apps.googleusercontent.com") ? undefined : "… .apps.googleusercontent.com"),
    });
    let clientSecret = "";
    while (!clientSecret) clientSecret = await p.secret(t(locale, "askGoogleSecret"));
    return { clientId, clientSecret };
  }
  const clientId = MICROSOFT_DEFAULT_CLIENT_ID
    ? undefined
    : await p.text(t(locale, "askClientId"), { validate: (v) => (GUID.test(v) ? undefined : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx") });
  const tenant = detected.tenant === "consumers" ? "consumers" : (await p.text(t(locale, "askTenant"), { default: "" })) || undefined;
  return { ...(clientId ? { clientId } : {}), ...(tenant ? { tenant } : {}) };
}

function profileOf(account: AccountConfig): OAuthProfile {
  if (account.auth.type !== "oauth2") throw new Error("not an OAuth account");
  return account.auth.provider === "microsoft" ? microsoftProfile(account.auth) : googleProfile(account.auth);
}

async function signIn(deps: SetupDeps, account: AccountConfig, staged: MemorySecretStore): Promise<void> {
  const { prompter: p, locale } = deps;
  const profile = profileOf(account);
  const mode =
    profile.provider === "microsoft"
      ? await p.select(
          t(locale, "askSignInMode"),
          [
            { value: "browser" as const, label: t(locale, "signInBrowser") },
            { value: "code" as const, label: t(locale, "signInCode") },
          ],
          "browser",
        )
      : "browser";
  const { refreshToken } = await deps.authorize(profile, mode, account.email);
  await staged.set(account.id, "oauthRefreshToken", refreshToken);
  p.print(t(locale, "signedIn"));
}

async function addAccount(deps: SetupDeps, existing: AppConfig | undefined): Promise<AppConfig | undefined> {
  const { prompter: p, locale } = deps;
  const taken = new Set(existing?.accounts.map((a) => a.id) ?? []);
  const email = (await p.text(t(locale, "askEmail"), { validate: (v) => (EMAIL.test(v) ? undefined : t(locale, "invalidEmail")) })).trim();

  p.print(t(locale, "detecting"));
  const detected = await deps.detect(email);
  p.print(t(locale, "detected", { name: detected.name }));
  p.print(t(locale, "serverLine", { protocol: "IMAP", host: detected.imap.host, port: detected.imap.port }));
  p.print(t(locale, "serverLine", { protocol: "SMTP", host: detected.smtp.host, port: detected.smtp.port }));
  for (const note of detected.notes) p.print(`  ${note[locale]}`);
  if (detected.helpUrl) p.print(t(locale, "helpLink", { url: detected.helpUrl }));

  let imap = { host: detected.imap.host, port: detected.imap.port };
  let smtp = { host: detected.smtp.host, port: detected.smtp.port };
  if (!(await p.confirm(t(locale, "useDetected"), detected.source !== "guess"))) {
    imap = {
      host: await p.text(t(locale, "askImapHost"), { default: imap.host }),
      port: Number(await p.text(t(locale, "askImapPort"), { default: String(imap.port), validate: portProblem(locale) })),
    };
    smtp = {
      host: await p.text(t(locale, "askSmtpHost"), { default: smtp.host }),
      port: Number(await p.text(t(locale, "askSmtpPort"), { default: String(smtp.port), validate: portProblem(locale) })),
    };
  }

  const oauthProvider = detected.auth === "oauth2-microsoft" ? "microsoft" : detected.auth === "oauth2-google" ? "google" : undefined;
  const method = oauthProvider
    ? await p.select(
        t(locale, "askAuthMethod"),
        [
          { value: "oauth" as const, label: t(locale, "authOAuth", { provider: oauthProvider === "microsoft" ? "Microsoft" : "Google" }) },
          { value: "password" as const, label: t(locale, "authPassword") },
        ],
        "oauth",
      )
    : "password";

  const id = await p.text(t(locale, "askAccountId"), {
    default: suggestAccountId(email, taken),
    validate: (v) => (ACCOUNT_ID.test(v) && !taken.has(v) ? undefined : t(locale, "invalidAccountId")),
  });
  const displayName = (await p.text(t(locale, "askDisplayName"), { default: "" })).trim();

  const auth =
    method === "oauth" && oauthProvider
      ? { type: "oauth2" as const, provider: oauthProvider, ...(await askOAuthSettings(deps, oauthProvider, detected)) }
      : { type: "password" as const, ...(detected.usernameStyle === "localpart" ? { username: email.split("@")[0] } : {}) };

  let account = AccountSchema.parse({
    id,
    email,
    imap,
    smtp,
    auth,
    identities: displayName ? [{ email, name: displayName }] : [],
    locale,
  });

  const staged = new MemorySecretStore();
  const appPassword = detected.auth !== "password";
  let provider: AuthProvider;
  if (account.auth.type === "oauth2") {
    await signIn(deps, account, staged);
    provider = new OAuthAuthProvider(account, staged);
  } else {
    provider = await askPassword(deps, account, staged, appPassword);
  }

  for (let attempt = 0; ; attempt++) {
    p.print(t(locale, "testing"));
    const report = await deps.test(account, provider, detected.presetId);
    if (report.imap.ok) {
      p.print(
        t(locale, "imapOk", {
          folders: report.imap.folderCount,
          keywords: t(locale, report.imap.capabilities.customKeywords ? "yes" : "no"),
        }),
      );
    }
    if (report.smtp?.ok) p.print(t(locale, "smtpOk"));
    const failed = failures(report);
    if (failed.length === 0) break;
    for (const f of failed) {
      p.print(t(locale, "stepFailed", { step: t(locale, f.step === "imap" ? "stepImap" : "stepSmtp"), message: f.diagnosis.message[locale] }));
    }

    const pinCandidate = failed.find((f) => f.diagnosis.offerCertificatePinning);
    if (pinCandidate) {
      const endpoint = pinCandidate.step === "imap" ? account.imap : account.smtp!;
      const implicitPort = pinCandidate.step === "imap" ? 993 : 465;
      const info = await deps.probe({
        host: endpoint.host,
        port: endpoint.port,
        protocol: pinCandidate.step,
        security: endpoint.port === implicitPort ? "implicit" : "starttls",
      });
      p.print(t(locale, "certTitle", { host: endpoint.host }));
      p.print(
        t(locale, "certDetails", { subject: info.subject, issuer: info.issuer, from: info.validFrom.slice(0, 10), to: info.validTo.slice(0, 10), fingerprint: info.fingerprint256 }),
      );
      if (await p.confirm(t(locale, "certTrust"), false)) {
        account = AccountSchema.parse({
          ...account,
          [pinCandidate.step]: { ...endpoint, tlsFingerprint256: info.fingerprint256, tlsCertificatePem: info.pem },
        });
        if (account.auth.type === "oauth2") provider = new OAuthAuthProvider(account, staged);
        continue;
      }
    }

    const loginRejected = failed.some((f) => f.diagnosis.code === "auth_failed" || f.diagnosis.code === "app_password_required");
    if (loginRejected && account.auth.type === "password" && attempt < 2 && (await p.confirm(t(locale, "retryPassword"), true))) {
      provider = await askPassword(deps, account, staged, appPassword);
      continue;
    }
    if (!(await p.confirm(t(locale, "saveAnyway"), false))) {
      p.print(t(locale, "cancelled"));
      return undefined;
    }
    break;
  }

  p.print(t(locale, "permIntro"));
  const permissions = {
    read: await p.confirm(t(locale, "permRead"), true),
    write: await p.confirm(t(locale, "permWrite"), true),
    send: await p.confirm(t(locale, "permSend"), false),
    delete: await p.confirm(t(locale, "permDelete"), false),
  };
  account = AccountSchema.parse({ ...account, permissions });

  const config = ConfigSchema.parse(existing ? { ...existing, accounts: [...existing.accounts, account] } : { version: 2, accounts: [account] });
  await deps.save(config, staged.entries(), []);
  p.print(t(locale, "saved"));
  p.print(t(locale, "nextSteps"));
  return config;
}

async function removeAccount(deps: SetupDeps, config: AppConfig): Promise<AppConfig> {
  const { prompter: p, locale } = deps;
  if (config.accounts.length === 1) {
    p.print(t(locale, "cannotRemoveLast"));
    return config;
  }
  const id = await p.select(t(locale, "chooseAccount"), config.accounts.map((a) => ({ value: a.id, label: `${a.id} <${a.email}>` })));
  if (!(await p.confirm(`${t(locale, "menuRemove")}: ${id}?`, false))) return config;
  const next = ConfigSchema.parse({
    ...config,
    accounts: config.accounts.filter((a) => a.id !== id),
    defaultAccount: config.defaultAccount === id ? undefined : config.defaultAccount,
  });
  await deps.save(next, [], [id]);
  p.print(t(locale, "removed", { id }));
  return next;
}

async function reauthenticate(deps: SetupDeps, config: AppConfig): Promise<void> {
  const { prompter: p, locale } = deps;
  const oauthAccounts = config.accounts.filter((a) => a.auth.type === "oauth2");
  if (oauthAccounts.length === 0) {
    p.print(t(locale, "noOAuthAccounts"));
    return;
  }
  const id = await p.select(t(locale, "chooseAccount"), oauthAccounts.map((a) => ({ value: a.id, label: `${a.id} <${a.email}>` })));
  const staged = new MemorySecretStore();
  await signIn(deps, oauthAccounts.find((a) => a.id === id)!, staged);
  await deps.save(config, staged.entries(), []);
}

/** Interactive setup. Returns the process exit code. */
export async function runSetup(deps: SetupDeps): Promise<number> {
  const { prompter: p, locale } = deps;
  p.print(t(locale, "welcome"));
  if (deps.envMode) p.print(t(locale, "envMode"));
  try {
    let config = await deps.loadExisting();
    if (!config) return (await addAccount(deps, undefined)) ? 0 : 1;
    for (;;) {
      const hasOAuth = config.accounts.some((a) => a.auth.type === "oauth2");
      const action = await p.select(
        t(locale, "menu"),
        [
          { value: "add" as const, label: t(locale, "menuAdd") },
          { value: "remove" as const, label: t(locale, "menuRemove") },
          ...(hasOAuth ? [{ value: "reauth" as const, label: t(locale, "menuReauth") }] : []),
          { value: "done" as const, label: t(locale, "menuDone") },
        ],
        "done",
      );
      if (action === "done") return 0;
      if (action === "add") config = (await addAccount(deps, config)) ?? config;
      if (action === "remove") config = await removeAccount(deps, config);
      if (action === "reauth") await reauthenticate(deps, config);
    }
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      p.print(t(locale, "cancelled"));
      return 130;
    }
    throw err;
  } finally {
    p.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/setup.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup.ts src/cli/__tests__/setup.test.ts src/__tests__/helpers/scripted-prompter.ts
git commit -m "feat(cli): guided setup with detection, connection test, certificate trust and OAuth

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: CLI commands — `doctor`, `accounts list`, `accounts login`, entry point

**Files:**
- Create: `src/cli/args.ts`, `src/cli/doctor.ts`, `src/cli/login.ts`, `src/cli/run.ts`, `src/cli/main.ts`
- Test: `src/cli/__tests__/args.test.ts`, `src/cli/__tests__/doctor.test.ts`, `src/cli/__tests__/login.test.ts`, `src/cli/__tests__/run.test.ts`
- Delete: `src/setup.ts` (Plan 2's minimal wizard)
- Modify: `package.json` (bin + scripts), `CLAUDE.md` (Commands, Entry points)

**Interfaces:**
- Consumes: `loadConfig(env, { secrets })`, `saveConfig(config, env)`, `configFilePath(env)` (Plan 2); `createSecretStore` (Task 3); `createAuthProvider` (Plan 2 + Task 7); `profileFor` (Task 4); `runLoopbackAuthorization`, `runDeviceCodeAuthorization`, `InteractiveAuthOptions` with `openBrowser: false`, `listenHost`, `port` (Task 5); `detectProvider`, `withDetectedEndpoints` (Task 9); `probeCertificate` (Task 6); `testAccountConnection`, `diagnose` (Task 10); `t`, `Locale`, `createTerminalPrompter` (Task 11); `runSetup` (Task 12).
- Produces (Plans 5–7 anchor on this):
  - `src/cli/args.ts`: `type LoginMode = "browser" | "no-browser" | "device-code"`, `interface AccountsLoginCommand { command: "accounts-login"; accountId; mode; listenHost?; port? }`, `type CliCommand = { command: "setup" } | { command: "doctor" } | { command: "accounts-list" } | AccountsLoginCommand | { command: "help" } | { command: "invalid"; message: LocalizedText }`, `parseCliArgs(argv: string[]): CliCommand` (pure; no argument = `setup`)
  - `src/cli/login.ts`: `interface LoginDeps { locale; print; loadConfig(); secrets; loopback?; deviceCode? }`, `runAccountsLogin(cmd, deps): Promise<number>`
  - `src/cli/doctor.ts`: `interface DoctorDeps { locale; print; secrets; loadConfig(); createProvider(account, secrets); test(account, provider) }`, `runDoctor(deps)`, `describeTls(locale, protocol, endpoint)`, `formatAccountList(locale, config)`
  - `src/cli/run.ts`: `interface CliDeps { env; locale; print(line); createSecrets(env): SecretStore }`, `defaultCliDeps(env?)`, `setupCommand(deps)`, `doctorCommand(deps)`, `accountsListCommand(deps)`, `accountsLoginCommand(cmd, deps)`, `runCli(argv, deps?): Promise<number>` — a `switch (cmd.command)` over `parseCliArgs(argv)`; `help` prints `t(locale, "usage")` (exit 0), `invalid` prints the message and the usage (exit 2)
  - `src/cli/main.ts`: entry only — `runCli(process.argv.slice(2))` → `process.exit(code)`
  - Adding a command later: extend `CliCommand` and `parseCliArgs` (args.ts), add `case` + `<name>Command(deps)` in run.ts, extend the `usage` text (messages.ts, de + en). Containers (Plan 7) replace `CliDeps.createSecrets`.
  - CLI: `imap-mcp-setup [setup | doctor | accounts list | accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]]`

- [ ] **Step 1: Write the failing tests**

`src/cli/__tests__/args.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../args.js";

describe("parseCliArgs", () => {
  it.each([
    [[], { command: "setup" }],
    [["setup"], { command: "setup" }],
    [["doctor"], { command: "doctor" }],
    [["accounts", "list"], { command: "accounts-list" }],
    [["--help"], { command: "help" }],
    [["help"], { command: "help" }],
  ])("%j", (argv, expected) => {
    expect(parseCliArgs(argv)).toEqual(expected);
  });

  it("parses accounts login in its three modes", () => {
    expect(parseCliArgs(["accounts", "login", "work"])).toEqual({ command: "accounts-login", accountId: "work", mode: "browser" });
    expect(parseCliArgs(["accounts", "login", "work", "--device-code"])).toEqual({ command: "accounts-login", accountId: "work", mode: "device-code" });
    expect(parseCliArgs(["accounts", "login", "work", "--no-browser", "--listen-host", "0.0.0.0", "--port", "53682"])).toEqual({
      command: "accounts-login",
      accountId: "work",
      mode: "no-browser",
      listenHost: "0.0.0.0",
      port: 53682,
    });
  });

  it.each([
    [["accounts", "login"], /needs the mailbox id/],
    [["accounts", "login", "--no-browser"], /needs the mailbox id/],
    [["accounts", "login", "work", "--device-code", "--no-browser"], /cannot be combined/],
    [["accounts", "login", "work", "--port", "53682"], /only work together with --no-browser/],
    [["accounts", "login", "work", "--no-browser", "--port", "99999"], /between 1 and 65535/],
    [["accounts", "login", "work", "--no-browser", "--listen-host"], /needs a value/],
    [["accounts", "login", "work", "--verbose"], /Unknown option: --verbose/],
    [["accounts"], /expects "list" or "login <id>"/],
    [["doctor", "--fix"], /Unknown option for doctor/],
    [["frobnicate"], /Unknown command: frobnicate/],
  ])("rejects %j", (argv, message) => {
    const cmd = parseCliArgs(argv);
    expect(cmd.command).toBe("invalid");
    if (cmd.command === "invalid") {
      expect(cmd.message.en).toMatch(message);
      expect(cmd.message.de.length).toBeGreaterThan(0);
    }
  });
});
```

`src/cli/__tests__/doctor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../config/schema.js";
import { MemorySecretStore } from "../../secrets/memory-store.js";
import type { AccountTestReport } from "../../onboarding/connection-test.js";
import { describeTls, formatAccountList, runDoctor, type DoctorDeps } from "../doctor.js";

const config = ConfigSchema.parse({
  version: 2,
  accounts: [
    {
      id: "main",
      email: "max@firma.example",
      imap: { host: "mail.firma.example", port: 143 },
      smtp: { host: "mail.firma.example", port: 587 },
      permissions: { send: true },
    },
  ],
});

const OK: AccountTestReport = {
  imap: { ok: true, folderCount: 5, capabilities: { specialUse: true, uidplus: true, move: true, idle: true, customKeywords: false } },
  smtp: { ok: true },
};

function deps(secrets: MemorySecretStore, report: AccountTestReport, lines: string[]): DoctorDeps {
  return {
    locale: "en",
    print: (l) => lines.push(l),
    loadConfig: async () => config,
    secrets,
    createProvider: () => ({ imapAuth: async () => ({ user: "u", pass: "p" }), smtpAuth: async () => ({ user: "u", pass: "p" }), invalidate: async () => {} }),
    test: async () => report,
  };
}

describe("runDoctor", () => {
  it("reports a healthy account with exit code 0", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("main", "password", "pw");
    const lines: string[] = [];
    expect(await runDoctor(deps(secrets, OK, lines))).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("✓ Credentials stored");
    expect(text).toContain("IMAP: encrypted (mandatory STARTTLS, port 143)");
    expect(text).toContain("Custom labels: no");
    expect(text).toContain("read ✓, write ✓, send ✓, delete ✗");
    expect(text).toContain("Everything is fine.");
  });

  it("fails with exit code 1 when the secret is missing", async () => {
    const lines: string[] = [];
    expect(await runDoctor(deps(new MemorySecretStore(), OK, lines))).toBe(1);
    expect(lines.join("\n")).toContain("No credentials stored");
  });

  it("prints the diagnosis of a failing step", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("main", "password", "pw");
    const lines: string[] = [];
    const broken: AccountTestReport = { ...OK, smtp: { ok: false, error: new Error(), diagnosis: { code: "timeout", message: { de: "x", en: "SMTP does not answer" } } } };
    expect(await runDoctor(deps(secrets, broken, lines))).toBe(1);
    expect(lines.join("\n")).toContain("✗ Sending (SMTP): SMTP does not answer");
  });

  it("reports an unreadable configuration", async () => {
    const lines: string[] = [];
    const d = { ...deps(new MemorySecretStore(), OK, lines), loadConfig: async () => { throw new Error("No configuration found"); } };
    expect(await runDoctor(d)).toBe(1);
    expect(lines.join("\n")).toContain("imap-mcp-setup");
  });
});

describe("describeTls / formatAccountList", () => {
  it("describes pinned and loopback endpoints", () => {
    expect(describeTls("en", "IMAP", { host: "127.0.0.1", port: 1143 })).toContain("local connection");
    expect(describeTls("en", "IMAP", { host: "x", port: 993, tlsFingerprint256: "AB:CD", tlsCertificatePem: "P" })).toContain("pinned certificate");
  });

  it("lists accounts with auth type and tiers", () => {
    expect(formatAccountList("en", config)[0]).toMatch(/main\s+max@firma.example\s+mail\.firma.example\s+password\s+read\+write\+send/);
  });
});
```

`src/cli/__tests__/login.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../config/schema.js";
import { MemorySecretStore } from "../../secrets/memory-store.js";
import type { InteractiveAuthOptions } from "../../auth/oauth/flow.js";
import type { OAuthProfile } from "../../auth/oauth/profiles.js";
import { runAccountsLogin, type LoginDeps } from "../login.js";

const config = ConfigSchema.parse({
  version: 2,
  accounts: [
    { id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } },
    { id: "work", email: "max@firma.at", imap: { host: "outlook.office365.com", port: 993 }, auth: { type: "oauth2", provider: "microsoft", clientId: "cid", tenant: "firma.at" } },
    {
      id: "gws",
      email: "max@firma-gws.at",
      imap: { host: "imap.gmail.com", port: 993 },
      auth: { type: "oauth2", provider: "google", clientId: "x.apps.googleusercontent.com", clientSecret: "s" },
    },
  ],
});

function deps(overrides: Partial<LoginDeps> = {}) {
  const lines: string[] = [];
  const secrets = new MemorySecretStore();
  const calls: Array<{ kind: "loopback" | "device"; profile: OAuthProfile; opts: InteractiveAuthOptions }> = [];
  const d: LoginDeps = {
    locale: "en",
    print: (l) => lines.push(l),
    loadConfig: async () => config,
    secrets,
    loopback: async (profile, opts) => {
      calls.push({ kind: "loopback", profile, opts });
      return { accessToken: "at", refreshToken: "rt-loopback", expiresAt: 0 };
    },
    deviceCode: async (profile, opts) => {
      calls.push({ kind: "device", profile, opts });
      return { accessToken: "at", refreshToken: "rt-device", expiresAt: 0 };
    },
    ...overrides,
  };
  return { d, lines, secrets, calls };
}

describe("accounts login", () => {
  it("signs in with the browser and stores the refresh token", async () => {
    const { d, lines, secrets, calls } = deps();
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "work", mode: "browser" }, d)).toBe(0);
    expect(await secrets.get("work", "oauthRefreshToken")).toBe("rt-loopback");
    expect(calls[0].profile.tokenUrl).toContain("/firma.at/");
    expect(calls[0].opts).toMatchObject({ loginHint: "max@firma.at", language: "en" });
    expect(calls[0].opts.openBrowser).toBeUndefined();
    expect(lines.at(-1)).toBe("✓ Signed in: max@firma.at. The sign-in has been saved.");
  });

  it("--no-browser disables the browser and passes listen host and port (container)", async () => {
    const { d, calls } = deps();
    await runAccountsLogin({ command: "accounts-login", accountId: "work", mode: "no-browser", listenHost: "0.0.0.0", port: 53682 }, d);
    expect(calls[0].opts).toMatchObject({ openBrowser: false, listenHost: "0.0.0.0", port: 53682 });
  });

  it("--device-code uses the Microsoft device code flow", async () => {
    const { d, secrets, calls } = deps();
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "work", mode: "device-code" }, d)).toBe(0);
    expect(calls[0].kind).toBe("device");
    expect(await secrets.get("work", "oauthRefreshToken")).toBe("rt-device");
  });

  it("refuses the device code flow for Google with a clear message", async () => {
    const { d, lines, calls } = deps();
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "gws", mode: "device-code" }, d)).toBe(1);
    expect(lines.join("\n")).toContain("Google offers no sign-in with a code");
    expect(calls).toHaveLength(0);
  });

  it("refuses password accounts and unknown ids", async () => {
    const { d, lines, calls } = deps();
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "main", mode: "browser" }, d)).toBe(1);
    expect(lines.at(-1)).toMatch(/signs in with a password/);
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "nope", mode: "browser" }, d)).toBe(1);
    expect(lines.at(-1)).toBe('There is no mailbox "nope". Configured: main, work, gws.');
    expect(calls).toHaveLength(0);
  });

  it("reports a failed sign-in and stores nothing", async () => {
    const { d, lines, secrets } = deps({
      loopback: async () => {
        throw new Error("Sign-in was cancelled or access was not granted.");
      },
    });
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "work", mode: "browser" }, d)).toBe(1);
    expect(lines.at(-1)).toBe("✗ Sign-in failed: Sign-in was cancelled or access was not granted.");
    expect(await secrets.get("work", "oauthRefreshToken")).toBeNull();
  });
});
```

`src/cli/__tests__/run.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemorySecretStore } from "../../secrets/memory-store.js";
import { runCli, type CliDeps } from "../run.js";

describe("runCli", () => {
  let home: string;
  let lines: string[];
  let deps: CliDeps;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-cli-"));
    lines = [];
    deps = {
      env: { IMAP_MCP_HOME: home, IMAP_MCP_NO_AUTOCONFIG: "1" },
      locale: "en",
      print: (l) => lines.push(l),
      createSecrets: () => new MemorySecretStore(),
    };
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ version: 2, accounts: [{ id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } }] }),
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("prints the usage for help (exit 0) and for unknown input (exit 2)", async () => {
    expect(await runCli(["--help"], deps)).toBe(0);
    expect(lines.join("\n")).toContain("accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]");
    lines.length = 0;
    expect(await runCli(["accounts", "login", "main", "--port", "1"], deps)).toBe(2);
    expect(lines[0]).toBe("--listen-host and --port only work together with --no-browser.");
    expect(lines[1]).toMatch(/^Usage:/);
  });

  it("dispatches accounts login and refuses a password mailbox without opening anything", async () => {
    expect(await runCli(["accounts", "login", "main"], deps)).toBe(1);
    expect(lines.at(-1)).toMatch(/signs in with a password/);
  });

  it("lists the accounts of the config file", async () => {
    expect(await runCli(["accounts", "list"], deps)).toBe(0);
    expect(lines[0]).toMatch(/main\s+max@firma.example\s+mail\.firma.example\s+password\s+read\+write/);
  });

  it("speaks German when asked", async () => {
    expect(await runCli(["frobnicate"], { ...deps, locale: "de" })).toBe(2);
    expect(lines[0]).toBe("Unbekannter Befehl: frobnicate");
    expect(lines[1]).toMatch(/^Verwendung:/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/args.test.ts src/cli/__tests__/doctor.test.ts src/cli/__tests__/login.test.ts src/cli/__tests__/run.test.ts`
Expected: FAIL — `Failed to resolve import "../args.js"` (and `../doctor.js`, `../login.js`, `../run.js`).

- [ ] **Step 3: Implement the commands**

`src/cli/args.ts`:

```ts
import type { LocalizedText } from "../onboarding/presets.js";

export type LoginMode = "browser" | "no-browser" | "device-code";

export interface AccountsLoginCommand {
  command: "accounts-login";
  accountId: string;
  mode: LoginMode;
  /** Only with --no-browser: interface the redirect receiver listens on (container: 0.0.0.0). */
  listenHost?: string;
  /** Only with --no-browser: fixed receiver port (container: the published port). */
  port?: number;
}

export type CliCommand =
  | { command: "setup" }
  | { command: "doctor" }
  | { command: "accounts-list" }
  | AccountsLoginCommand
  | { command: "help" }
  | { command: "invalid"; message: LocalizedText };

function invalid(de: string, en: string): CliCommand {
  return { command: "invalid", message: { de, en } };
}

function parseLogin(args: string[]): CliCommand {
  const [accountId, ...flags] = args;
  if (!accountId || accountId.startsWith("-")) {
    return invalid(
      "„accounts login“ braucht die Kennung des Postfachs, z. B.: accounts login main",
      '"accounts login" needs the mailbox id, e.g.: accounts login main',
    );
  }
  let mode: LoginMode = "browser";
  let listenHost: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--device-code" || flag === "--no-browser") {
      const next: LoginMode = flag === "--device-code" ? "device-code" : "no-browser";
      if (mode !== "browser" && mode !== next) {
        return invalid("--device-code und --no-browser schließen einander aus.", "--device-code and --no-browser cannot be combined.");
      }
      mode = next;
    } else if (flag === "--listen-host" || flag === "--port") {
      const value = flags[++i];
      if (value === undefined || value.startsWith("--")) return invalid(`${flag} braucht einen Wert.`, `${flag} needs a value.`);
      if (flag === "--port") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return invalid(`--port muss eine Zahl zwischen 1 und 65535 sein (nicht „${value}“).`, `--port must be a number between 1 and 65535 (not "${value}").`);
        }
        port = n;
      } else {
        listenHost = value;
      }
    } else {
      return invalid(`Unbekannte Option: ${flag}`, `Unknown option: ${flag}`);
    }
  }
  if ((listenHost !== undefined || port !== undefined) && mode !== "no-browser") {
    return invalid("--listen-host und --port gehen nur zusammen mit --no-browser.", "--listen-host and --port only work together with --no-browser.");
  }
  return {
    command: "accounts-login",
    accountId,
    mode,
    ...(listenHost !== undefined ? { listenHost } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

/** Pure argument parsing for `imap-mcp-setup`; no argument means `setup`. */
export function parseCliArgs(argv: string[]): CliCommand {
  const [first, second, ...rest] = argv;
  if (first === undefined) return { command: "setup" };
  if (first === "help" || first === "--help" || first === "-h") return { command: "help" };
  if (first === "setup" || first === "doctor") {
    return argv.length === 1 ? { command: first } : invalid(`Unbekannte Option für ${first}: ${second}`, `Unknown option for ${first}: ${second}`);
  }
  if (first === "accounts") {
    if (second === "list" && rest.length === 0) return { command: "accounts-list" };
    if (second === "login") return parseLogin(rest);
    return invalid("„accounts“ erwartet „list“ oder „login <id>“.", '"accounts" expects "list" or "login <id>".');
  }
  return invalid(`Unbekannter Befehl: ${first}`, `Unknown command: ${first}`);
}
```

`src/cli/doctor.ts`:

```ts
import type { AccountConfig, AppConfig } from "../config/schema.js";
import type { AuthProvider } from "../auth/provider.js";
import type { SecretStore } from "../secrets/store.js";
import { isLoopback, pinFromEndpoint } from "../connection-security.js";
import type { AccountTestReport } from "../onboarding/connection-test.js";
import { diagnose } from "../onboarding/diagnose.js";
import { errorMessage } from "../errors.js";
import { t, type Locale } from "./messages.js";

export interface DoctorDeps {
  locale: Locale;
  print(line: string): void;
  /** Created before the config is loaded (Plan 2: loadConfig(env, { secrets })). */
  secrets: SecretStore;
  loadConfig(): Promise<AppConfig>;
  createProvider(account: AccountConfig, secrets: SecretStore): AuthProvider;
  test(account: AccountConfig, provider: AuthProvider): Promise<AccountTestReport>;
}

export function describeTls(locale: Locale, protocol: "IMAP" | "SMTP", endpoint: AccountConfig["imap"]): string {
  const pin = pinFromEndpoint(endpoint);
  if (pin) return t(locale, "tlsPinned", { protocol, fingerprint: `${pin.fingerprint256.slice(0, 23)}…` });
  const implicitPort = protocol === "IMAP" ? 993 : 465;
  if (endpoint.port === implicitPort) return t(locale, "tlsImplicit", { protocol, port: endpoint.port });
  if (isLoopback(endpoint.host)) return t(locale, "tlsLoopback", { protocol, host: endpoint.host, port: endpoint.port });
  return t(locale, "tlsStartTls", { protocol, port: endpoint.port });
}

/** Non-interactive health report. Exit code 0 = everything works, 1 = at least one problem. */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const { locale, print } = deps;
  print(t(locale, "doctorTitle"));
  let config: AppConfig;
  try {
    config = await deps.loadConfig();
  } catch (err) {
    print(t(locale, "configFailed", { message: errorMessage(err) }));
    print(t(locale, "runSetup"));
    return 1;
  }
  print(t(locale, "configOk", { count: config.accounts.length }));
  const secrets = deps.secrets;

  let problems = 0;
  for (const account of config.accounts) {
    print("");
    print(`${account.id} <${account.email}>`);
    const key = account.auth.type === "password" ? "password" : "oauthRefreshToken";
    try {
      if (!(await secrets.get(account.id, key))) {
        print(t(locale, "secretMissing"));
        problems++;
        continue;
      }
      print(t(locale, "secretOk"));
    } catch (err) {
      print(t(locale, "secretFailed", { message: diagnose(err, { protocol: "imap", host: account.imap.host, port: account.imap.port }).message[locale] }));
      problems++;
      continue;
    }

    print(describeTls(locale, "IMAP", account.imap));
    if (account.smtp) print(describeTls(locale, "SMTP", account.smtp));

    const report = await deps.test(account, deps.createProvider(account, secrets));
    if (report.imap.ok) {
      print(t(locale, "imapOk", { folders: report.imap.folderCount, keywords: t(locale, report.imap.capabilities.customKeywords ? "yes" : "no") }));
    } else {
      print(t(locale, "stepFailed", { step: t(locale, "stepImap"), message: report.imap.diagnosis.message[locale] }));
      problems++;
    }
    if (!report.smtp) {
      print(t(locale, "smtpMissing"));
    } else if (report.smtp.ok) {
      print(t(locale, "smtpOk"));
    } else {
      print(t(locale, "stepFailed", { step: t(locale, "stepSmtp"), message: report.smtp.diagnosis.message[locale] }));
      problems++;
    }

    const tiers = (["read", "write", "send", "delete"] as const).map((tier) => `${tier} ${account.permissions[tier] ? "✓" : "✗"}`);
    print(t(locale, "permissionsLine", { list: tiers.join(", ") }));
  }

  print("");
  print(problems === 0 ? t(locale, "doctorOk") : t(locale, "doctorProblems", { count: problems }));
  return problems === 0 ? 0 : 1;
}

export function formatAccountList(locale: Locale, config: AppConfig | undefined): string[] {
  if (!config || config.accounts.length === 0) return [t(locale, "accountsEmpty")];
  return config.accounts.map((a) => {
    const auth = a.auth.type === "oauth2" ? `oauth2:${a.auth.provider}` : "password";
    const tiers = (["read", "write", "send", "delete"] as const).filter((tier) => a.permissions[tier]).join("+");
    const marker = config.defaultAccount === a.id ? "*" : " ";
    return `${marker} ${a.id.padEnd(16)} ${a.email.padEnd(32)} ${a.imap.host.padEnd(28)} ${auth.padEnd(16)} ${tiers}`;
  });
}
```

`src/cli/login.ts`:

```ts
import type { AppConfig } from "../config/schema.js";
import type { SecretStore } from "../secrets/store.js";
import { profileFor, type OAuthProfile } from "../auth/oauth/profiles.js";
import {
  runDeviceCodeAuthorization,
  runLoopbackAuthorization,
  type AuthorizedTokens,
  type InteractiveAuthOptions,
} from "../auth/oauth/flow.js";
import { errorMessage } from "../errors.js";
import type { AccountsLoginCommand } from "./args.js";
import { t, type Locale } from "./messages.js";

export interface LoginDeps {
  locale: Locale;
  print(line: string): void;
  loadConfig(): Promise<AppConfig>;
  /** Whatever createSecretStore returns (Plan 7: the container runtime store). */
  secrets: SecretStore;
  loopback?(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens>;
  deviceCode?(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens>;
}

/** `accounts login <id>`: sign an OAuth mailbox in (again) without the wizard — also inside containers. */
export async function runAccountsLogin(cmd: AccountsLoginCommand, deps: LoginDeps): Promise<number> {
  const { locale, print } = deps;
  try {
    const config = await deps.loadConfig();
    const account = config.accounts.find((a) => a.id === cmd.accountId);
    if (!account) {
      print(t(locale, "loginUnknownAccount", { id: cmd.accountId, ids: config.accounts.map((a) => a.id).join(", ") }));
      return 1;
    }
    if (account.auth.type !== "oauth2") {
      print(t(locale, "loginNotOAuth", { id: account.id }));
      return 1;
    }
    const profile = profileFor(account);
    if (cmd.mode === "device-code" && !profile.deviceCodeUrl) {
      print(t(locale, "loginNoDeviceCode", { provider: profile.provider === "google" ? "Google" : "Microsoft" }));
      return 1;
    }
    const opts: InteractiveAuthOptions = {
      print,
      language: locale,
      loginHint: account.email,
      ...(cmd.mode === "no-browser" ? { openBrowser: false as const } : {}),
      ...(cmd.listenHost !== undefined ? { listenHost: cmd.listenHost } : {}),
      ...(cmd.port !== undefined ? { port: cmd.port } : {}),
    };
    const tokens =
      cmd.mode === "device-code"
        ? await (deps.deviceCode ?? runDeviceCodeAuthorization)(profile, opts)
        : await (deps.loopback ?? runLoopbackAuthorization)(profile, opts);
    await deps.secrets.set(account.id, "oauthRefreshToken", tokens.refreshToken);
    print(t(locale, "loginSuccess", { email: account.email }));
    return 0;
  } catch (err) {
    print(t(locale, "loginFailed", { message: errorMessage(err) }));
    return 1;
  }
}
```

`src/cli/run.ts`:

```ts
import * as fs from "node:fs";
import { configFilePath, loadConfig, saveConfig } from "../config/load.js";
import type { AppConfig } from "../config/schema.js";
import { createSecretStore, type SecretStore } from "../secrets/store.js";
import { createAuthProvider } from "../auth/provider.js";
import { runDeviceCodeAuthorization, runLoopbackAuthorization } from "../auth/oauth/flow.js";
import { detectProvider, withDetectedEndpoints } from "../onboarding/autoconfig.js";
import { probeCertificate } from "../onboarding/cert-probe.js";
import { testAccountConnection } from "../onboarding/connection-test.js";
import { errorMessage } from "../errors.js";
import { parseCliArgs, type AccountsLoginCommand } from "./args.js";
import { formatAccountList, runDoctor } from "./doctor.js";
import { runAccountsLogin } from "./login.js";
import { detectLocale, t, type Locale } from "./messages.js";
import { createTerminalPrompter } from "./prompt.js";
import { runSetup } from "./setup.js";

/** What every CLI command needs. Tests replace parts; Plan 7 replaces `createSecrets` for containers. */
export interface CliDeps {
  env: NodeJS.ProcessEnv;
  locale: Locale;
  print(line: string): void;
  createSecrets(env: NodeJS.ProcessEnv): SecretStore;
}

export function defaultCliDeps(env: NodeJS.ProcessEnv = process.env): CliDeps {
  return {
    env,
    locale: detectLocale(env),
    print: (line) => process.stdout.write(`${line}\n`),
    createSecrets: (e) => createSecretStore(e),
  };
}

const autoconfigEnabled = (env: NodeJS.ProcessEnv) => env.IMAP_MCP_NO_AUTOCONFIG !== "1";

/** The config file the wizard edits — never the env-only configuration. */
async function loadFileConfig(env: NodeJS.ProcessEnv, secrets: SecretStore): Promise<AppConfig | undefined> {
  if (!fs.existsSync(configFilePath(env))) return undefined;
  return loadConfig({ ...env, IMAP_MCP_EMAIL: "" }, { secrets });
}

/** The configuration the server would use (env-only or file), hosts autodetected like the server does. */
async function loadEffectiveConfig(env: NodeJS.ProcessEnv, secrets: SecretStore): Promise<AppConfig> {
  return loadConfig(autoconfigEnabled(env) ? await withDetectedEndpoints(env) : env, { secrets });
}

export async function setupCommand(deps: CliDeps): Promise<number> {
  const prompter = createTerminalPrompter(deps.locale);
  const secrets = deps.createSecrets(deps.env);
  return runSetup({
    prompter,
    locale: deps.locale,
    envMode: Boolean(deps.env.IMAP_MCP_EMAIL),
    loadExisting: () => loadFileConfig(deps.env, secrets),
    save: async (config, staged, removed) => {
      for (const s of staged) await secrets.set(s.accountId, s.key, s.value);
      for (const id of removed) {
        await secrets.delete(id, "password").catch(() => {});
        await secrets.delete(id, "oauthRefreshToken").catch(() => {});
      }
      await saveConfig(config, deps.env);
    },
    detect: (email) => detectProvider(email, { network: autoconfigEnabled(deps.env) }),
    test: (account, provider, presetId) => testAccountConnection(account, provider, { presetId }),
    probe: probeCertificate,
    authorize: (profile, mode, loginHint) => {
      const opts = { print: (line: string) => prompter.print(line), language: deps.locale, loginHint };
      return mode === "browser" ? runLoopbackAuthorization(profile, opts) : runDeviceCodeAuthorization(profile, opts);
    },
  });
}

export async function doctorCommand(deps: CliDeps): Promise<number> {
  const secrets = deps.createSecrets(deps.env);
  return runDoctor({
    locale: deps.locale,
    print: deps.print,
    secrets,
    loadConfig: () => loadEffectiveConfig(deps.env, secrets),
    createProvider: (account, store) => createAuthProvider(account, store),
    test: (account, provider) => testAccountConnection(account, provider),
  });
}

export async function accountsListCommand(deps: CliDeps): Promise<number> {
  const secrets = deps.createSecrets(deps.env);
  try {
    const configured = fs.existsSync(configFilePath(deps.env)) || Boolean(deps.env.IMAP_MCP_EMAIL?.trim());
    const config = configured ? await loadConfig(deps.env, { secrets }) : undefined;
    for (const line of formatAccountList(deps.locale, config)) deps.print(line);
    return 0;
  } catch (err) {
    deps.print(t(deps.locale, "configFailed", { message: errorMessage(err) }));
    return 1;
  }
}

export async function accountsLoginCommand(cmd: AccountsLoginCommand, deps: CliDeps): Promise<number> {
  const secrets = deps.createSecrets(deps.env);
  return runAccountsLogin(cmd, {
    locale: deps.locale,
    print: deps.print,
    secrets,
    loadConfig: () => loadEffectiveConfig(deps.env, secrets),
  });
}

/**
 * `imap-mcp-setup [setup | doctor | accounts list | accounts login <id> …]`. Returns the exit code.
 * New commands: extend CliCommand + parseCliArgs (args.ts), add a `case` here and a `<name>Command(deps)` function.
 */
export async function runCli(argv: string[], deps: CliDeps = defaultCliDeps()): Promise<number> {
  const cmd = parseCliArgs(argv);
  switch (cmd.command) {
    case "setup":
      return setupCommand(deps);
    case "doctor":
      return doctorCommand(deps);
    case "accounts-list":
      return accountsListCommand(deps);
    case "accounts-login":
      return accountsLoginCommand(cmd, deps);
    case "help":
      deps.print(t(deps.locale, "usage"));
      return 0;
    case "invalid":
      deps.print(cmd.message[deps.locale]);
      deps.print(t(deps.locale, "usage"));
      return 2;
  }
}
```

`src/cli/main.ts`:

```ts
#!/usr/bin/env node
import { errorMessage } from "../errors.js";
import { runCli } from "./run.js";

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exit(1);
  },
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/cli`
Expected: PASS (args 17, doctor 6, login 6, run 4, plus the prompt and setup tests).

- [ ] **Step 5: Replace the old wizard and update bins/scripts**

```bash
git rm src/setup.ts
npm pkg set bin.imap-mcp-setup="dist/cli/main.js"
npm pkg set scripts.setup="node dist/cli/main.js setup"
npm pkg set scripts.doctor="node dist/cli/main.js doctor"
```

In `CLAUDE.md` → Commands, replace the Setup line with:

```markdown
- **Setup:** `npm run setup` (guided: provider detection, hidden password, OAuth sign-in, connection test, certificate trust)
- **Doctor:** `npm run doctor` (non-interactive health report; exit code 1 on problems)
- **Sign in again (OAuth):** `node dist/cli/main.js accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]`
```

and in Architecture → Entry points replace the `src/setup.ts` bullet with:

```markdown
- `src/cli/main.ts` → `runCli()` in `src/cli/run.ts`: `imap-mcp-setup [setup | doctor | accounts list | accounts login <id> …]`. Parsing in `args.ts` (pure), commands in `setup.ts`, `doctor.ts`, `login.ts` (dependency-injected, tested with fakes and a scripted prompter).
```

- [ ] **Step 6: Build and smoke-test the CLI**

Run: `npm run build && node dist/cli/main.js --help; echo "exit=$?"`
Expected: the usage block starting `Usage:` / `Verwendung:` with the four command lines; `exit=0`.

Run: `IMAP_MCP_HOME=$(mktemp -d) node dist/cli/main.js doctor; echo "exit=$?"`
Expected: `✗ Konfiguration: …` / `✗ Configuration: …`, the hint to run `imap-mcp-setup`, `exit=1`.

Run: `node dist/cli/main.js accounts login main --port 1; echo "exit=$?"`
Expected: `--listen-host and --port only work together with --no-browser.` (or German) followed by the usage; `exit=2`.

Container check (with Plan 7's image, or any Linux container with the build mounted): `docker run --rm -it -p 127.0.0.1:53682:53682 … node dist/cli/main.js accounts login work --no-browser --listen-host 0.0.0.0 --port 53682` prints a sign-in link whose `redirect_uri` is `http://localhost:53682`; opening it in the host's browser completes the sign-in and prints `✓ Signed in: …`.

- [ ] **Step 7: Commit**

```bash
git add package.json src/cli CLAUDE.md
git commit -m "feat(cli): doctor, accounts list and accounts login; setup moves to src/cli

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Provider guide, manual acceptance and version 0.5.0

**Files:**
- Create: `docs/guide/providers.md`
- Modify: `CLAUDE.md` (Infrastructure modules: secrets, auth, onboarding)
- Modify: `package.json`, `src/version.ts` (version 0.5.0)

**Interfaces:**
- Consumes: messages and presets from Tasks 9–13 (the guide uses the same wording and URLs).
- Produces: `docs/guide/providers.md` (Plan 6 links it from the README and the user guide).

- [ ] **Step 1: Write the provider guide**

`docs/guide/providers.md`:

````markdown
# Connecting your mailbox — provider guide

Run `imap-mcp-setup` and enter your email address. Setup recognises most providers automatically, tests the connection before it saves anything, and stores passwords and sign-ins in your operating system's keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service) — never in a file.

Check everything at any time with `imap-mcp-setup doctor`.

This page lists what you may have to do **at your provider** before setup succeeds.

| Provider | How you sign in | What to prepare |
|---|---|---|
| Gmail (personal) | App password | 2-Step Verification on, create an app password |
| Google Workspace | Google sign-in in the browser | Administrator creates an internal OAuth client (once) |
| Microsoft 365 / Exchange Online | Microsoft sign-in in the browser | Administrator registers the app and allows SMTP sending (once) |
| Outlook.com, Hotmail, Live | Microsoft sign-in in the browser | App registration that allows personal accounts |
| iCloud Mail | App-specific password | Create it at Apple |
| Yahoo Mail | App password | Create it at Yahoo |
| GMX, WEB.DE | Password (app-specific password with 2FA) | Turn on "POP3/IMAP Abruf" |
| Telekom (t-online.de) | E-mail password | Use the separate e-mail password |
| IONOS, STRATO, mailbox.org, Posteo | Mailbox password | Nothing |
| Own server (Dovecot/Postfix, Mailcow, …) | Mailbox password | Encryption on port 993/465 or STARTTLS; see below for self-signed certificates |
| Proton Mail | Bridge password | Install and start Proton Mail Bridge |

## Gmail (personal account)

Google does not accept your normal password for mail programs.

1. Open <https://myaccount.google.com/security> and make sure **2-Step Verification** is on.
2. Open <https://myaccount.google.com/apppasswords>, enter a name such as `Claude Mail` and choose **Create**.
3. Copy the 16-character password (spaces do not matter) and paste it when setup asks for the app password.

Changing your Google password revokes all app passwords; run setup again afterwards. Help: <https://support.google.com/accounts/answer/185833>

## Google Workspace (organisation) — for the administrator

Personal Gmail apps need Google's verification for full mail access. Inside your own organisation an **internal** OAuth client avoids that.

1. In the Admin console, allow IMAP: **Apps → Google Workspace → Gmail → End User Access → POP and IMAP access**.
2. In <https://console.cloud.google.com/> select (or create) a project that belongs to your organisation.
3. **Google Auth Platform → Branding**: app name `imap-mcp`, support email. **Audience**: user type **Internal**.
4. **Data Access → Add or remove scopes**: add `https://mail.google.com/`.
5. **Clients → Create client**: application type **Desktop app**, name `imap-mcp`. Copy **Client ID** and **Client secret**.
6. Give both values to your users. In setup they choose **"With your Google account in the browser"** and paste them.

For a desktop client Google does not treat the client secret as confidential; setup stores it in the configuration file (readable only by the user).

## Microsoft 365 / Exchange Online — for the administrator

Microsoft has switched off password logins for IMAP. Sending with a password (SMTP AUTH) becomes off-by-default for existing tenants in late December 2026. Use the Microsoft sign-in.

### A. Register the app (once per organisation)

Skip this part if your imap-mcp distribution ships a Microsoft client ID and your organisation allows it; then only grant consent with
`https://login.microsoftonline.com/<your-domain>/adminconsent?client_id=<client-id>`.

1. Open <https://entra.microsoft.com> → **Applications → App registrations → New registration**.
2. Name `imap-mcp`; supported account types **Accounts in this organizational directory only**; redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`. Register.
3. **Authentication → Advanced settings → Allow public client flows: Yes** (needed for "sign in with a code on another device").
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**: `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`. Then **Grant admin consent for <organisation>**.
5. Copy **Application (client) ID** and give it to your users together with your domain (setup asks for "Anwendungs-ID (Client-ID)" and "Mandant").

If Conditional Access blocks the device code flow (recommended by Microsoft), users simply use the browser sign-in.

### B. Allow sending (SMTP AUTH) for each mailbox that sends

Security defaults and tenants created after January 2020 disable SMTP AUTH. Enable it per mailbox in PowerShell:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser   # once
Connect-ExchangeOnline -UserPrincipalName admin@your-domain.example
Set-CASMailbox -Identity user@your-domain.example -SmtpClientAuthenticationDisabled $false
Get-CASMailbox -Identity user@your-domain.example | Format-List SmtpClientAuthenticationDisabled
```

`False` means sending is allowed. Sent mail is filed in "Sent Items" by Microsoft automatically. Help: <https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission>

## Outlook.com, Hotmail, Live (personal Microsoft accounts)

Personal accounts also need the Microsoft sign-in. The app registration must allow personal accounts (supported account types **"… and personal Microsoft accounts"**); setup uses the tenant `consumers` automatically.

## iCloud Mail

1. Sign in at <https://account.apple.com> → **Sign-In and Security → App-Specific Passwords → Generate**.
2. Name it `Claude Mail`, copy the password and paste it in setup.

Two-factor authentication must be on. Help: <https://support.apple.com/en-us/102654>

## Yahoo Mail

Open **Account security → Generate app password** (<https://help.yahoo.com/kb/SLN15241.html>), name it `Claude Mail`, paste it in setup.

## GMX and WEB.DE

1. Log in to the webmail, open **Einstellungen → POP3/IMAP Abruf** and turn on **"POP3 und IMAP Zugriff erlauben"**.
2. If two-factor login is on, create an **anwendungsspezifisches Passwort** and use it in setup.

At WEB.DE the login name is the part of the address before "@"; setup handles that. Help: <https://hilfe.gmx.net/pop-imap/einschalten.html>, <https://hilfe.web.de/pop-imap/einschalten.html>

## Telekom (t-online.de, magenta.de)

Use the separate **E-Mail-Passwort** from the Telekom Kundencenter, not your Telekom login password: <https://www.telekom.de/hilfe/festnetz-internet-tv/e-mail/e-mail-passwort>

## IONOS, STRATO, mailbox.org, Posteo

Use the mailbox password. IONOS only accepts sender addresses of your own domain.

## Your own mail server (Dovecot/Postfix, Mailcow, …)

- **Encryption is mandatory.** Use port 993 (IMAP) and 465 (SMTP), or 143/587 with STARTTLS. If the server offers neither, setup refuses to connect — otherwise the password would travel in clear text.
- **Best: a real certificate** (for example Let's Encrypt). Then nothing else is needed.
- **Self-signed certificate:** setup shows the certificate (issued to, issuer, validity, SHA-256 fingerprint) and asks whether to trust exactly this certificate. Compare the fingerprint on the server first:

  ```bash
  # Dovecot (path differs per distribution; see ssl_cert in dovecot.conf)
  openssl x509 -in /etc/dovecot/private/dovecot.pem -noout -fingerprint -sha256
  # Mailcow
  openssl x509 -in data/assets/ssl/cert.pem -noout -fingerprint -sha256
  ```

  Only confirm in setup if both fingerprints are identical. When you renew the certificate, run `imap-mcp-setup` again; until then the connection is refused with "the server presented a different certificate", which also protects you against interception.
- Setup reads `https://autoconfig.<your-domain>/mail/config-v1.1.xml` if you publish one (Mailcow does), so users only need to type their address.

## Proton Mail

Install and start **Proton Mail Bridge** (<https://proton.me/mail/bridge>). In setup use the **Bridge password** shown in the Bridge app. The Bridge uses a self-signed certificate on `127.0.0.1`; trust it when setup asks.

## Privacy note on auto-detection

To find the server settings, setup looks up your domain's MX records and asks `autoconfig.<your-domain>` and Mozilla's `autoconfig.thunderbird.net` for the domain (never the password). Set `IMAP_MCP_NO_AUTOCONFIG=1` to switch these lookups off and enter the servers yourself.

## Troubleshooting

`imap-mcp-setup doctor` explains each problem. The most common ones:

| Message | Fix |
|---|---|
| "Login rejected … requires an app password" | Create an app password (see your provider above). |
| "POP3/IMAP Abruf" mentioned | Turn on IMAP access in the GMX/WEB.DE settings. |
| "SMTP sending disabled for this mailbox" | Administrator runs `Set-CASMailbox … -SmtpClientAuthenticationDisabled $false`. |
| "no longer accepts password logins" | Choose the Microsoft sign-in in setup. |
| "The sign-in … is no longer valid" | `imap-mcp-setup` → **Sign in again**. |
| "certificate … not signed by a known authority" | Compare fingerprints and trust the certificate in setup (own server only). |
| "presented a different certificate" | Certificate was renewed — run setup again; if you did not renew it, contact your administrator. |
| "offers no encryption (STARTTLS)" | Use port 993/465 or enable TLS on the server. |
| "credential store could not be used" (Linux) | Install and unlock gnome-keyring or KWallet, or pass secrets as environment variables. |
````

- [ ] **Step 2: Document the new modules in `CLAUDE.md`**

Add under "Infrastructure modules":

```markdown
- `src/secrets/` — `SecretStore` chain: env vars first (Plan 2), then the OS keychain: `createKeychainStore` uses `@napi-rs/keyring` (service `imap-mcp`, account `<id>:<key>`, Linux pinned to Secret Service) or, when the native module cannot load (MCPB bundle), the OS tools (`/usr/bin/security`, DPAPI files in `~/.imap-mcp/secrets`, `secret-tool`). `MigratingSecretStore` moves keytar-era secrets once. `MemorySecretStore` stages secrets during setup.
- `src/auth/oauth/` — PKCE loopback sign-in (`flow.ts`), Microsoft device-code fallback, token client, `OAuthAuthProvider` (2-minute expiry skew, single-flight refresh, rotated refresh tokens persisted), `SignInManager` behind the `sign_in` tool (45 s per call, 5 min flow).
- `src/onboarding/` — provider presets + detection (domain table → MX → autoconfig → guess), certificate probe, connection test, `diagnose()` (plain-language de/en messages).
- `src/connection-security.ts` — also certificate pinning (`TlsPin`, `pinnedTlsOptions`): the pinned certificate is the only trust anchor and its SHA-256 fingerprint replaces the hostname check.
```

- [ ] **Step 3: Manual acceptance (real providers)**

Run `npm run build`, then for each row run `node dist/cli/main.js setup`, add the account, and afterwards `node dist/cli/main.js doctor`. Tick only when doctor reports "Alles in Ordnung." / "Everything is fine.":

- [ ] Gmail with app password (detected by domain; the normal password is rejected with the app-password hint and Google link)
- [ ] GMX or WEB.DE (WEB.DE: login name is the part before "@")
- [ ] Microsoft 365 via browser sign-in (custom domain detected by MX; refresh token in the keychain, not in `config.json`; restart the MCP server after 70 minutes and read mail → no new sign-in)
- [ ] Microsoft 365 device-code sign-in ("Mit einem Code auf einem anderen Gerät")
- [ ] Microsoft 365 mailbox with SMTP AUTH disabled → doctor shows the admin hint with `Set-CASMailbox`
- [ ] Google Workspace with an internal OAuth client
- [ ] Own Dovecot/Postfix with self-signed certificate: setup shows the fingerprint; it matches `openssl x509 -in <cert> -noout -fingerprint -sha256`; after trusting, doctor shows "festgelegtes Zertifikat"; after replacing the certificate doctor reports the changed certificate
- [ ] Server on port 143 without STARTTLS → setup refuses and suggests port 993
- [ ] Windows: an existing keytar-era installation starts and reads mail without asking for the password again; the old entry is gone from Windows Credential Manager ("imap-mcp-server" / "imap-mcp")
- [ ] Windows without `@napi-rs/keyring` (delete `node_modules/@napi-rs`): setup stores the password; `%USERPROFILE%\.imap-mcp\secrets\main.password.dpapi` exists and contains no readable password
- [ ] macOS without `@napi-rs/keyring`: password appears in Keychain Access under `imap-mcp`; `ps` during setup never shows it
- [ ] Linux desktop session without a keyring → plain-language keychain error naming the fix; with gnome-keyring unlocked → works
- [ ] Bundle mode (Task 8 Step 6) with Microsoft 365 → `sign_in` flow works from the chat
- [ ] `node dist/cli/main.js accounts login <m365-id> --device-code` and `… --no-browser` re-sign in without the wizard; a password account is refused with the plain message

- [ ] **Step 4: Set the version to 0.5.0**

Plans 3 and 4 may run in parallel, so set the version without relying on the previous value:

```bash
npm pkg set version=0.5.0
node -e "const fs=require('fs');const f='src/version.ts';fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/VERSION = .*;/,'VERSION = '+JSON.stringify('0.5.0')+';'))"
npm run build && npm test
node -e "import('./dist/version.js').then((m) => console.log(m.VERSION))"
```

Expected: `src/version.ts` contains `export const VERSION = "0.5.0";`, `npm pkg get version` prints `"0.5.0"`, all tests pass, the last command prints `0.5.0`.

- [ ] **Step 5: Commit**

```bash
git add docs/guide/providers.md CLAUDE.md package.json src/version.ts
git commit -m "docs: provider setup guide; release 0.5.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Contract additions (for spec §9.3)

- `createSecretStore(env?, opts?)` keeps its signature; the keychain part is `MigratingSecretStore(createKeychainStore({ secretsDir: <configDir>/secrets }), loadKeytarReader)` — `@napi-rs/keyring`, else OS tools (macOS `security`, Windows DPAPI files `<configDir>/secrets/<id>.<key>.dpapi`, Linux `secret-tool`). `readLegacyKeytarPassword`/`deleteLegacyKeytarPassword` move to `src/secrets/keytar-migration.ts`; `src/secrets/keytar-store.ts` is deleted.
- `EndpointSchema.tlsCertificatePem?: string` — PEM of the pinned certificate; `ConfigSchema.superRefine` requires it together with a matching `tlsFingerprint256` (`pinProblem()` in `schema.ts`). `EndpointSchema` and `AccountSchema` stay plain, extendable objects.
- `imapSecurityOptions(host, port, pin?)`, `smtpSecurityOptions(host, port, pin?)`, `pinFromEndpoint(endpoint)`; `ImapConnectionManager` endpoint parameter carries the pin fields.
- `OAuthAuthProvider implements AuthProvider`; `createAuthProvider` returns it for `oauth2` accounts. Errors surfaced to Claude: `OAuthSignInRequiredError` ("Not signed in yet — ask me to run sign_in"), `OAuthReauthRequiredError`, `OAuthConfigurationError`.
- Env-only auth: `IMAP_MCP_AUTH` (password | microsoft | google), `IMAP_MCP_OAUTH_CLIENT_ID`, `IMAP_MCP_OAUTH_CLIENT_SECRET` (Google), `IMAP_MCP_OAUTH_TENANT` (Microsoft) via `authFromEnv` in `configFromEnv`. Plan 6 maps MCPB `user_config` to these (client secret as `sensitive`).
- `AppContext.secrets: SecretStore`; tool `sign_in` (tier `always`, open-world). Plan 7 must not register `sign_in` in HTTP mode (it would open a browser on the server machine).
- `withDetectedEndpoints(env)` fills `IMAP_MCP_IMAP_HOST/PORT`, `IMAP_MCP_SMTP_HOST/PORT` in env-only mode; `IMAP_MCP_NO_AUTOCONFIG=1` disables lookups.
- `MemorySecretStore` is a production module (`src/secrets/memory-store.ts`).
- CLI (`imap-mcp-setup`): `src/cli/main.ts` only calls `runCli(process.argv.slice(2))`; `runCli(argv, deps = defaultCliDeps())` in `src/cli/run.ts` switches over `parseCliArgs(argv)` (`src/cli/args.ts`, union `CliCommand`) and calls `setupCommand`, `doctorCommand`, `accountsListCommand`, `accountsLoginCommand(cmd, deps)`; `help` → usage, exit 0; `invalid` → message + usage, exit 2. `CliDeps { env, locale, print, createSecrets(env) }` — Plan 7 swaps `createSecrets` for containers. Usage text = `usage` key in `src/cli/messages.ts` (de + en).
- `accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]` stores the refresh token via `secrets.set(id, "oauthRefreshToken", …)`; in a container: `--no-browser --listen-host 0.0.0.0 --port 53682` with `docker run -p 127.0.0.1:53682:53682`; the redirect URI stays `http://localhost:<port>` (Microsoft) / `http://127.0.0.1:<port>` (Google).
- Version 0.5.0 is set in Task 14 with `npm pkg set version=0.5.0` and a regex replace in `src/version.ts` (independent of the previous value).
- New env vars: `IMAP_MCP_LANG` (de | en), `IMAP_MCP_NO_AUTOCONFIG`, `IMAP_MCP_KEYCHAIN_IT` (tests only).
