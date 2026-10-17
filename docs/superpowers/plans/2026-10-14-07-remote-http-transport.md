# Plan 7 — Remote HTTP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `imap-smtp-mcp` as a self-hosted, single-tenant remote MCP server over Streamable HTTP so claude.ai (custom connector), Claude Code and scheduled automations can use the mailboxes while the owner's PC is off — authenticated by static bearer tokens or by the organisation's own OAuth identity provider, and restricted per caller to specific mailboxes.

**Architecture:** A fetch-style router (`src/transport/http-app.ts`) in front of the SDK v2 `createMcpHandler(factory)` does Host/Origin validation, IP allow-listing, authentication (hashed bearer tokens or JWT validation against the IdP's JWKS with `jose`), principal → mailbox mapping and rate limiting, then serves each request statelessly with a fresh `McpServer` built by Plan 2's `createServer(app)` over a principal-scoped view of the shared `AppContext`. `@hono/node-server`'s `getRequestListener` adapts it to `node:http`. In containers, secrets come only from environment variables, `*_FILE` Docker secrets and an AES-GCM state file for rotating OAuth refresh tokens.

**Tech Stack:** TypeScript (ESM, strict), `@modelcontextprotocol/server` 2.x (`createMcpHandler`, `hostHeaderValidationResponse`, `originValidationResponse`), `@modelcontextprotocol/client` 2.x (tests), `jose` 6.2, `@hono/node-server` 1.19, zod 4, vitest, Docker (distroless Node 22), Caddy 2.

**Spec:** `docs/superpowers/specs/2026-10-14-production-readiness-design.md` (decision D12, §3.4 "Remote connectors", §7 threat "Remote endpoint abuse", §9 contracts)

**Validation note:** This plan was applied, in task order, to the end state of Plans 1–6 rebuilt from their plan texts: Plan 2's validated tree plus every code block and edit of Plans 3, 4 and 5 and of Plan 6 Tasks 1–3 (the Plan 6 tasks that touch `src/`; Tasks 4–14 are bundle build, CI, docs and release). That baseline ran 709 tests green, 2 skipped (Plan 5 reports 670 for Plans 1–5). With this plan: `tsc` (build and tests) clean, **822 green, 2 skipped** (113 new), using `jose@6.2.12` and `@hono/node-server@1.19.17`. Smoke-tested through `dist/bin.js`: `serve --http` exits 2 without `httpAuth`; with a config it serves `/healthz` 200 and `/mcp` 401 without a token, writes the audit folder, and `dist/cli/healthcheck.js` exits 0 (1 when the server is down); `http token create --id smoke --print-only` prints the token once; `help` lists both new commands. Not executed: the Docker steps (no Docker daemon was available) and the manual claude.ai/Entra acceptance in the deploy guide.

## Global Constraints

- Release `1.1.0` of package `imap-smtp-mcp` (Plan 6, decision O1). Node `>=20.18.0` (Plan 2 engines). ESM with `.js` import suffixes, TypeScript strict.
- New runtime dependencies, exactly: `jose@^6.2.12`, `@hono/node-server@^1.19.17`. No Express, no other new runtime dependency. `@modelcontextprotocol/client` stays a devDependency.
- Anchors in the Plan 1–6 end state this plan builds on (all verified; Task 1 re-checks them):
  - `src/server.ts` (Plan 2) — side-effect-free `createServer(app: AppContext): McpServer` (instructions from `src/instructions.ts`, name/version from `src/version.ts`, tools from `ALL_TOOLS` in `src/tools/index.ts`; Plan 4 appended the tool `sign_in` — tier `"always"`, opens a browser on the machine running the server — and Plan 3 `organize_by_filter`, `get_thread`, `forward_draft`, `save_attachment`).
  - `src/serve.ts` (Plan 2's `src/index.ts`, moved by Plan 6) — `export async function serve(_args: string[] = []): Promise<void>`: `createSecretStore()` → host autodetection → `loadConfig` → `createAppContext` → `setupAudit(app)` → `serveStdio(() => createServer(app))`.
  - `src/cli/dispatch.ts` (Plan 6) — `type Command`, `SUBCOMMANDS`, `parseCommand`, `helpText()` (descriptions start at index 17); `src/cli/program.ts` — `run(parsed)` switch: `"serve"` → `applyBundleArgs` + `serve(args)`, `"setup" | "doctor" | "accounts" | "audit"` → `runCli([command, ...args])`; entry point `src/bin.ts` → `dist/bin.js` (`dist/cli/main.js` and `dist/index.js` are pre-1.0 shims).
  - `src/cli/run.ts` (Plan 4) — `interface CliDeps { env; locale; print(line); createSecrets(env): SecretStore }`, `defaultCliDeps(env?)` with `createSecrets: (e) => createSecretStore(e)`; `accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]` already exists.
  - `src/context.ts` — `AppContext { config; accounts; defaultAccountId; observers; resolveAccount(id?); anyAccountAllows(tier); shutdown() }` (`anyAccountAllows` uses Plan 5's `tierAllowed`), `AccountRuntime`, `ToolCallEvent`, `ToolObserver`, `AccountNotFoundError(requested, available)`, `createAppContext(config, secrets, deps?)`.
  - `src/policy/engine.ts` (Plan 5) — `tierAllowed(account: AccountConfig, tier): boolean` (a drafts-only account never gets the send tier); `src/audit/setup.ts` — `setupAudit(app: Pick<AppContext, "config" | "observers">, env?)` pushes the `AuditLog` into `app.observers` and throws when the audit folder is not writable; `AuditLog` writes `sanitizeDetails(event.details, level)` (keeps `principal`/`principalKind`), reads only with `audit.includeReads`.
  - `src/config/schema.ts` — `ConfigSchema = z.object({ version, defaultAccount, accounts, files, audit }).superRefine(…)`; `AppConfig`, `AccountConfig`, `PermissionTier` are exported **here**. `files.attachmentDirs` / `files.downloadDir` (Plan 3; env-only: `IMAP_MCP_ATTACHMENT_DIRS`, `IMAP_MCP_DOWNLOAD_DIR`).
  - `src/config/load.ts` — `loadConfig(env?, { secrets? })`, `saveConfig(config, env?)`; `src/onboarding/autoconfig.ts` (Plan 4) — `withDetectedEndpoints(env)`.
  - `src/secrets/store.ts` — `SecretKey`, `SecretStore`, `secretEnvName(accountId, key)`, `EnvSecretStore` (also reads `*_FILE`), `ChainSecretStore`, `createSecretStore(env?, { keychain?: boolean })`.
  - `src/bulk/run.ts` (Plan 3) — `selectionStore(app)` is keyed by `app.config`, so the per-request `AppContext` view of this plan shares one store and a preview made in one HTTP request can be committed in another.
  - `src/tools/shared/define-tool.ts` resolves the account via `app.resolveAccount`, lists `app.accounts` and `app.defaultAccountId` in the `account` parameter, registers a tool only if `app.anyAccountAllows(tier)`, and notifies `app.observers` — so a per-request `AppContext` view scopes every tool without touching the tools.
  - Tests: `createTestApp(accounts?, config?)` (config parsed by `ConfigSchema`), `standardFakeImap()`, `FakeImap`, `buildRaw`; `isLoopback(host)` in `src/connection-security.ts`.
- HTTP mode never offers tools that act on the server machine: its per-request servers are built with `createServer(app, { exclude: LOCAL_ONLY_TOOLS })` (Task 1, Task 10). Mailboxes are signed in by an administrator with `imap-smtp-mcp accounts login <id> --no-browser` instead.
- Secret/config environment names (Plan 2, fixed): `IMAP_MCP_CONFIG` (config file path), `IMAP_MCP_HOME` (state dir, default `~/.imap-mcp`), `IMAP_MCP_PASSWORD_<ID>[_FILE]`, `IMAP_MCP_OAUTH_REFRESH_TOKEN_<ID>[_FILE]` (`<ID>` = account id upper-cased, `-` → `_`), env-only single-account mode via `IMAP_MCP_EMAIL` and friends. This plan adds `IMAP_MCP_CONTAINER`, `IMAP_MCP_STATE_KEY[_FILE]`, `IMAP_MCP_HTTP_HOST`, `IMAP_MCP_HTTP_PORT`.
- `serve --http` refuses to start without `httpAuth` — also on loopback. Default bind `127.0.0.1:8787`.
- Never log tokens, `Authorization` headers or message content. Logs carry principal id, client IP, outcome. Logging goes to stderr via `src/logging/logger.ts`.
- No CORS on `/mcp`. Only the secret-free protected-resource-metadata document carries `Access-Control-Allow-Origin: *`.
- Container mode (`IMAP_MCP_CONTAINER=1`) never constructs an OS-keychain store.
- Commits use conventional messages and end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Spoofed `X-Forwarded-For` behind the reverse proxy** — a client sends `X-Forwarded-For: 160.79.104.10` to slip past the IP allowlist; only the hop appended by the trusted proxy may count (test: Task 4 "uses the address appended by the trusted proxy").
2. **Entra ID token variations** — v2 access tokens carry `aud` = client-id GUID while some setups use `api://…`; delegated scopes arrive in `scp`, application permissions in `roles`; both must work, a Graph token must not (tests: Task 6 Entra cases).
3. **DNS rebinding and browser origins** — a web page makes the victim's browser call `http://127.0.0.1:8787/mcp` with a foreign `Host` or `Origin`; must be 403 before authentication (tests: Task 8 "blocks DNS rebinding", "blocks browser requests from foreign origins").
4. **Oversized request bodies** — a 70 KB body with a 64 KB limit must be answered 413 before authentication or any IMAP work, and with `Connection: close` so the keep-alive socket is not reused (test: Task 8 "answers 413").
5. **Expired tokens and rotated signing keys** — claude.ai keeps using an access token after expiry or after the IdP rotates keys; the answer must be 401 `invalid_token` with the `resource_metadata` challenge (so the client re-authenticates), never 500 (tests: Task 6 "expired token and unknown key id", Task 7 challenge headers).

---

### Task 1: Server factory with local-only tool exclusion; dependencies

**Files:**
- Modify: `src/server.ts`
- Modify: `package.json`, `package-lock.json`
- Test: `src/__tests__/server-factory.test.ts`

**Interfaces:**
- Consumes: `createServer(app: AppContext): McpServer` from `src/server.ts`, `ALL_TOOLS` from `src/tools/index.ts`, `createTestApp()` (Plan 2); the `sign_in` tool from `src/tools/sign-in.ts` (Plan 4: tier `"always"`, registered via `ALL_TOOLS`, opens a browser on the machine running the server).
- Produces: `export const LOCAL_ONLY_TOOLS: ReadonlySet<string>` (`"sign_in"`), `export interface CreateServerOptions { exclude?: ReadonlySet<string> }`, `createServer(app: AppContext, opts?: CreateServerOptions): McpServer` — backwards compatible (no options = every tool, as before); still a new, unconnected server per call. Excluded tools are neither listed nor callable.

- [ ] **Step 1: Verify the anchors**

Run:
```bash
grep -n "export function createServer" src/server.ts
grep -n "readonly defaultAccountId\|export class AccountNotFoundError\|export function createAppContext" src/context.ts
grep -n "superRefine\|export type AppConfig\|export type PermissionTier" src/config/schema.ts
grep -n "export async function loadConfig\|export async function saveConfig" src/config/load.ts
grep -n "export function createSecretStore\|export function secretEnvName" src/secrets/store.ts
grep -n "export function createTestApp" src/__tests__/helpers/test-app.ts
grep -n "export function isLoopback" src/connection-security.ts
grep -n '"sign_in"' src/tools/sign-in.ts
grep -n "export async function serve(_args" src/serve.ts
grep -n "export async function run(parsed" src/cli/program.ts
grep -n "export const SUBCOMMANDS" src/cli/dispatch.ts
grep -n "createSecrets: (e) => createSecretStore(e)" src/cli/run.ts
grep -n "export function setupAudit" src/audit/setup.ts
grep -n "export function tierAllowed" src/policy/engine.ts
```
Expected: every command prints exactly one line. If one does not, stop and reconcile with the plan that owns the file before editing; do not change the behaviour of earlier plans.

- [ ] **Step 2: Add the two runtime dependencies**

Run: `npm install jose@^6.2.12 @hono/node-server@^1.19.17`
Expected: `package.json` `dependencies` lists `"jose": "^6.2.12"` and `"@hono/node-server": "^1.19.17"`.

- [ ] **Step 3: Write the failing test**

```ts
// src/__tests__/server-factory.test.ts
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { createTestApp } from "./helpers/test-app.js";
import { LOCAL_ONLY_TOOLS, createServer } from "../server.js";

async function toolNames(server: McpServer): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "factory-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  await server.close();
  return names;
}

describe("createServer", () => {
  it("returns a fresh, unconnected server per call that lists the registered tools", async () => {
    const { app } = createTestApp();
    const first = createServer(app);
    expect(createServer(app)).not.toBe(first);
    expect(await toolNames(first)).toEqual(expect.arrayContaining(["search_emails", "list_accounts", "health_check"]));
  });

  it("leaves out excluded tools and keeps the rest", async () => {
    const { app } = createTestApp();
    const names = await toolNames(createServer(app, { exclude: new Set(["health_check"]) }));
    expect(names).not.toContain("health_check");
    expect(names).toEqual(expect.arrayContaining(["search_emails", "list_accounts"]));
  });

  it("does not let an excluded tool be called", async () => {
    const { app } = createTestApp();
    const server = createServer(app, { exclude: new Set(["health_check"]) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "factory-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const outcome = await client.callTool({ name: "health_check", arguments: {} }).then(
      (result) => (result.isError ? "error-result" : "ok"),
      () => "rejected",
    );
    expect(outcome).not.toBe("ok");
    await client.close();
    await server.close();
  });

  it("lists sign_in as a local-only tool", () => {
    expect(LOCAL_ONLY_TOOLS.has("sign_in")).toBe(true);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run src/__tests__/server-factory.test.ts`
Expected: FAIL — the first test passes (Plan 2 behaviour), "leaves out excluded tools…" and "does not let an excluded tool be called" fail because `health_check` is still registered, and "lists sign_in as a local-only tool" fails with `Cannot read properties of undefined (reading 'has')` (`LOCAL_ONLY_TOOLS` is not exported yet).

- [ ] **Step 5: Implement the option in `src/server.ts`**

Replace the file with (the body without options is exactly Plan 2's loop):

```ts
// src/server.ts
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/server";
import type { AppContext } from "./context.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { ALL_TOOLS } from "./tools/index.js";
import { SERVER_NAME, VERSION } from "./version.js";

/** Tools that act on the machine running the server (e.g. open a browser there) — never offered over HTTP. */
export const LOCAL_ONLY_TOOLS: ReadonlySet<string> = new Set(["sign_in"]);

export interface CreateServerOptions {
  /** Tool names to leave out; the HTTP transport passes LOCAL_ONLY_TOOLS. */
  exclude?: ReadonlySet<string>;
}

/** One MCP server instance with every tool the configured permissions allow. Side-effect free. */
export function createServer(app: AppContext, opts: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const exclude = opts.exclude ?? new Set<string>();
  if (exclude.size === 0) {
    for (const register of ALL_TOOLS) register(server, app);
    return server;
  }

  // McpServer offers no lookup by name, so keep the handles of excluded tools while ALL_TOOLS registers.
  const excluded: RegisteredTool[] = [];
  const registerTool = server.registerTool.bind(server) as unknown as (name: string, ...rest: unknown[]) => RegisteredTool;
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    const tool = registerTool(name, ...rest);
    if (exclude.has(name)) excluded.push(tool);
    return tool;
  }) as unknown as McpServer["registerTool"];
  for (const register of ALL_TOOLS) register(server, app);
  delete (server as { registerTool?: unknown }).registerTool; // back to the prototype method
  for (const tool of excluded) tool.remove(); // not connected yet, so no list_changed notification is sent
  return server;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__ && npm run typecheck`
Expected: PASS — `server-factory.test.ts` 4 tests, and Plan 2's existing `server.test.ts` unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/__tests__/server-factory.test.ts package.json package-lock.json
git commit -m "feat(server): exclude local-only tools (sign_in) from a server instance; add jose and @hono/node-server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: HTTP configuration schema

**Files:**
- Create: `src/config/http-schema.ts`
- Modify: `src/config/schema.ts`
- Test: `src/config/__tests__/http-schema.test.ts`, `src/config/__tests__/config-http.test.ts`

**Interfaces:**
- Consumes: `isLoopback(host: string): boolean` from `src/connection-security.ts`.
- Produces: `HttpSchema`, `HttpAuthSchema`, `PrincipalRuleSchema`, `BearerTokenSchema`, `RateLimitSchema`; `type HttpConfig`, `type HttpAuthConfig`; `interface DeploymentCheck { errors: string[]; warnings: string[] }`; `checkHttpDeployment({ http, httpAuth, accountIds }): DeploymentCheck`. `ConfigSchema` gains optional `http: HttpConfig` and `httpAuth: HttpAuthConfig`, so `AppConfig.http?` / `AppConfig.httpAuth?` exist.

- [ ] **Step 1: Write the failing tests**

```ts
// src/config/__tests__/http-schema.test.ts
import { describe, it, expect } from "vitest";
import { HttpAuthSchema, HttpSchema, checkHttpDeployment } from "../http-schema.js";

const sha = "a".repeat(64);

describe("HttpSchema", () => {
  it("defaults to loopback, port 8787, no proxy trust, 4 MiB bodies", () => {
    expect(HttpSchema.parse({})).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      trustProxy: false,
      maxBodyBytes: 4 * 1024 * 1024,
      ipAllowlist: [],
      rateLimit: { perMinute: 120, burst: 30, authFailuresPerMinute: 30 },
    });
  });

  it.each(["https://mail.example.com/mcp", "mail.example.com", "https://mail.example.com?x=1", "ftp://mail.example.com"])(
    "rejects publicUrl %s",
    (publicUrl) => {
      expect(HttpSchema.safeParse({ publicUrl }).success).toBe(false);
    },
  );

  it("accepts an origin with or without trailing slash", () => {
    expect(HttpSchema.parse({ publicUrl: "https://mail.example.com" }).publicUrl).toBe("https://mail.example.com");
    expect(HttpSchema.safeParse({ publicUrl: "https://mail.example.com:8443/" }).success).toBe(true);
  });
});

describe("HttpAuthSchema", () => {
  it("parses bearer mode with hashed tokens only", () => {
    expect(HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "laptop", sha256: sha }] })).toEqual({
      mode: "bearer",
      tokens: [{ id: "laptop", sha256: sha }],
      principals: [],
    });
    expect(HttpAuthSchema.safeParse({ mode: "bearer", tokens: [{ id: "laptop", token: "imcp_plain" }] }).success).toBe(false);
  });

  it("normalises a single audience and requires principals in OAuth mode", () => {
    const parsed = HttpAuthSchema.parse({
      mode: "oauth",
      issuer: "https://login.microsoftonline.com/tid/v2.0",
      audience: "api://imap-mcp",
      principals: [{ match: { group: "g-mail" }, accounts: ["office"] }],
    });
    expect(parsed).toMatchObject({ audience: ["api://imap-mcp"], clockToleranceSec: 60, algorithms: ["RS256", "PS256", "ES256"] });
    expect(HttpAuthSchema.safeParse({ mode: "oauth", issuer: "https://idp.example", audience: "x", principals: [] }).success).toBe(false);
  });

  it("rejects an http issuer and an empty match", () => {
    expect(HttpAuthSchema.safeParse({ mode: "oauth", issuer: "http://idp.example", audience: "x", principals: [{ match: { group: "g" }, accounts: ["a"] }] }).success).toBe(false);
    expect(HttpAuthSchema.safeParse({ mode: "bearer", principals: [{ match: {}, accounts: ["a"] }] }).success).toBe(false);
  });
});

describe("checkHttpDeployment", () => {
  const http = (over: Record<string, unknown> = {}) => HttpSchema.parse(over);

  it("refuses to start without authentication, even on loopback", () => {
    expect(checkHttpDeployment({ http: http(), httpAuth: undefined, accountIds: ["main"] }).errors[0]).toMatch(/requires "httpAuth"/);
  });

  it("refuses bearer mode without tokens", () => {
    const httpAuth = HttpAuthSchema.parse({ mode: "bearer" });
    expect(checkHttpDeployment({ http: http(), httpAuth, accountIds: ["main"] }).errors[0]).toMatch(/No bearer tokens/);
  });

  it("requires an https publicUrl for OAuth", () => {
    const httpAuth = HttpAuthSchema.parse({ mode: "oauth", issuer: "https://idp.example", audience: "a", principals: [{ match: { sub: "u" }, accounts: ["main"] }] });
    expect(checkHttpDeployment({ http: http({ host: "0.0.0.0", trustProxy: 1 }), httpAuth, accountIds: ["main"] }).errors.join(" ")).toMatch(/publicUrl/);
    expect(checkHttpDeployment({ http: http({ host: "0.0.0.0", trustProxy: 1, publicUrl: "http://mail.example.com" }), httpAuth, accountIds: ["main"] }).errors.join(" ")).toMatch(/https/);
    expect(checkHttpDeployment({ http: http({ host: "0.0.0.0", trustProxy: 1, publicUrl: "https://mail.example.com" }), httpAuth, accountIds: ["main"] }).errors).toEqual([]);
  });

  it("rejects principal rules for unknown accounts and warns about open bearer tokens", () => {
    const httpAuth = HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "a", sha256: sha }], principals: [{ match: { tokenId: "a" }, accounts: ["ghost"] }] });
    expect(checkHttpDeployment({ http: http(), httpAuth, accountIds: ["main", "shop"] }).errors[0]).toMatch(/unknown account "ghost"/);
    const open = HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "a", sha256: sha }] });
    expect(checkHttpDeployment({ http: http(), httpAuth: open, accountIds: ["main", "shop"] }).warnings[0]).toMatch(/every mailbox/);
  });

  it("requires a Host allowlist when bound to a public interface", () => {
    const httpAuth = HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "a", sha256: sha }] });
    expect(checkHttpDeployment({ http: http({ host: "0.0.0.0" }), httpAuth, accountIds: ["main"] }).errors[0]).toMatch(/allowedHosts/);
  });
});
```

```ts
// src/config/__tests__/config-http.test.ts
import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../schema.js";

const account = { id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } };

describe("ConfigSchema with HTTP settings", () => {
  it("keeps http and httpAuth optional", () => {
    const parsed = ConfigSchema.parse({ version: 2, accounts: [account] });
    expect(parsed.http).toBeUndefined();
    expect(parsed.httpAuth).toBeUndefined();
  });

  it("parses and defaults the http and httpAuth sections", () => {
    const parsed = ConfigSchema.parse({
      version: 2,
      accounts: [account],
      http: { port: 9000 },
      httpAuth: { mode: "bearer", tokens: [{ id: "laptop", sha256: "a".repeat(64) }] },
    });
    expect(parsed.http).toMatchObject({ host: "127.0.0.1", port: 9000 });
    expect(parsed.httpAuth).toEqual({ mode: "bearer", tokens: [{ id: "laptop", sha256: "a".repeat(64) }], principals: [] });
  });

  it("rejects a plaintext token in the config", () => {
    const result = ConfigSchema.safeParse({ version: 2, accounts: [account], httpAuth: { mode: "bearer", tokens: [{ id: "x", token: "imcp_x" }] } });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/config/__tests__/http-schema.test.ts src/config/__tests__/config-http.test.ts`
Expected: FAIL — `Cannot find module '../http-schema.js'`; `config-http` fails on `parsed.http` being undefined after parse (unknown keys stripped).

- [ ] **Step 3: Implement the schema module**

```ts
// src/config/http-schema.ts
import { z } from "zod";
import { isLoopback } from "../connection-security.js";

/** An origin only: scheme + host (+ port), no path, query or fragment. */
const originUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search && !url.hash && value.replace(/\/$/, "") === url.origin;
  } catch {
    return false;
  }
}, "Must be an origin like https://mail.example.com (no path)");

export const RateLimitSchema = z.object({
  perMinute: z.number().int().min(1).default(120),
  burst: z.number().int().min(1).default(30),
  authFailuresPerMinute: z.number().int().min(1).default(30),
});

export const HttpSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8787),
  /** Public origin clients use, e.g. https://mail.example.com — the MCP endpoint is <publicUrl>/mcp. */
  publicUrl: originUrl.optional(),
  /** Number of reverse proxies in front of the server (true = 1). X-Forwarded-For is ignored when 0/false. */
  trustProxy: z.union([z.boolean(), z.number().int().min(0).max(5)]).default(false),
  maxBodyBytes: z.number().int().min(1024).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  /** Extra Host header names accepted besides the publicUrl host (and loopback names when bound to loopback). */
  allowedHosts: z.array(z.string().min(1)).default([]),
  /** Origin hostnames accepted when a request carries an Origin header (browser clients). Default: none. */
  allowedOrigins: z.array(z.string().min(1)).default([]),
  /** CIDR ranges allowed to reach /mcp, e.g. ["160.79.104.0/21"] for claude.ai. Empty = no IP restriction. */
  ipAllowlist: z.array(z.string().min(1)).default([]),
  rateLimit: RateLimitSchema.prefault({}),
  requestTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
});

export const PrincipalRuleSchema = z.object({
  match: z
    .object({
      sub: z.string().min(1).optional(),
      email: z.string().min(1).optional(),
      group: z.string().min(1).optional(),
      tokenId: z.string().min(1).optional(),
    })
    .refine((m) => Object.values(m).some((v) => v !== undefined), "match needs at least one of sub, email, group, tokenId"),
  accounts: z.array(z.string().min(1)).min(1),
});

export const BearerTokenSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const HttpAuthSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("bearer"),
    tokens: z.array(BearerTokenSchema).default([]),
    principals: z.array(PrincipalRuleSchema).default([]),
  }),
  z.object({
    mode: z.literal("oauth"),
    issuer: z.string().refine((v) => /^https:\/\//.test(v) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(v), "issuer must be an https URL"),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).transform((a) => (Array.isArray(a) ? a : [a])),
    jwksUri: z.string().optional(),
    /** Checked against the token (scope/scp/roles claims), short names as the IdP puts them into tokens. */
    requiredScopes: z.array(z.string().min(1)).default([]),
    /** Advertised in protected resource metadata (what clients request), e.g. "api://<client-id>/mail.access". Default: requiredScopes. */
    scopesSupported: z.array(z.string().min(1)).optional(),
    clockToleranceSec: z.number().int().min(0).max(300).default(60),
    algorithms: z.array(z.enum(["RS256", "PS256", "ES256", "EdDSA"])).min(1).default(["RS256", "PS256", "ES256"]),
    principals: z.array(PrincipalRuleSchema).min(1, "OAuth mode needs at least one principals rule (who may use which mailbox)"),
  }),
]);

export type HttpConfig = z.output<typeof HttpSchema>;
export type HttpAuthConfig = z.output<typeof HttpAuthSchema>;

export interface DeploymentCheck {
  errors: string[];
  warnings: string[];
}

/** Cross-field rules that decide whether `serve --http` may start. */
export function checkHttpDeployment(input: {
  http: HttpConfig;
  httpAuth: HttpAuthConfig | undefined;
  accountIds: string[];
}): DeploymentCheck {
  const { http, httpAuth, accountIds } = input;
  const errors: string[] = [];
  const warnings: string[] = [];
  const loopbackBind = isLoopback(http.host);

  if (!httpAuth) {
    errors.push('HTTP mode requires "httpAuth" (bearer tokens or OAuth). Run `imap-smtp-mcp http token create --id <name>`.');
  } else if (httpAuth.mode === "bearer" && httpAuth.tokens.length === 0) {
    errors.push("No bearer tokens configured. Run `imap-smtp-mcp http token create --id <name>`.");
  } else if (httpAuth.mode === "oauth") {
    if (!http.publicUrl) errors.push('OAuth mode requires "http.publicUrl" (the HTTPS origin clients connect to).');
    else if (!http.publicUrl.startsWith("https://") && !isLoopback(new URL(http.publicUrl).hostname)) {
      errors.push('"http.publicUrl" must use https:// outside of local testing.');
    }
  }
  if (!loopbackBind && !http.publicUrl && http.allowedHosts.length === 0) {
    errors.push('Bound to a non-loopback address: set "http.publicUrl" or "http.allowedHosts" so Host headers can be checked.');
  }
  for (const rule of httpAuth?.principals ?? []) {
    for (const id of rule.accounts) {
      if (id !== "*" && !accountIds.includes(id)) errors.push(`principals rule refers to unknown account "${id}".`);
    }
  }
  if (!loopbackBind && http.trustProxy === false && http.ipAllowlist.length === 0) {
    warnings.push("Listening on a public interface without a reverse proxy or IP allowlist. Put Caddy/nginx with TLS in front.");
  }
  if (httpAuth?.mode === "bearer" && httpAuth.principals.length === 0 && accountIds.length > 1) {
    warnings.push("Every bearer token can use every mailbox. Add httpAuth.principals rules to restrict tokens.");
  }
  return { errors, warnings };
}
```

- [ ] **Step 4: Wire it into `ConfigSchema`**

In `src/config/schema.ts` replace

```ts
import { z } from "zod";
```

with

```ts
import { z } from "zod";
import { HttpAuthSchema, HttpSchema } from "./http-schema.js";
```

`ConfigSchema` is `z.object({ version, defaultAccount, accounts, files, audit }).superRefine(…)`; the new keys go into the inner object. Replace

```ts
    audit: AuditSchema.prefault({}),
  })
  .superRefine((config, ctx) => {
```

with

```ts
    audit: AuditSchema.prefault({}),
    http: HttpSchema.optional(),
    httpAuth: HttpAuthSchema.optional(),
  })
  .superRefine((config, ctx) => {
```

(The `superRefine` body stays unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/config && npm run typecheck`
Expected: PASS — `http-schema.test.ts` 14, `config-http.test.ts` 3, plus all existing config tests.

- [ ] **Step 6: Commit**

```bash
git add src/config/http-schema.ts src/config/schema.ts src/config/__tests__/http-schema.test.ts src/config/__tests__/config-http.test.ts
git commit -m "feat(http): configuration schema and deployment checks for HTTP mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bearer tokens

**Files:**
- Create: `src/transport/auth/bearer.ts`
- Test: `src/transport/__tests__/bearer.test.ts`

**Interfaces:**
- Produces: `interface BearerTokenEntry { id: string; sha256: string }`, `TOKEN_PREFIX = "imcp_"`, `hashToken(token): string`, `generateBearerToken(): { token: string; sha256: string }`, `parseBearerHeader(value: string | null | undefined): string | null`, `matchBearerToken(presented: string, entries: BearerTokenEntry[]): string | null` (returns the token id).

- [ ] **Step 1: Write the failing test**

```ts
// src/transport/__tests__/bearer.test.ts
import { describe, it, expect } from "vitest";
import { generateBearerToken, hashToken, matchBearerToken, parseBearerHeader } from "../auth/bearer.js";

describe("bearer tokens", () => {
  it("generates a prefixed 256-bit token and returns only its hash for storage", () => {
    const { token, sha256 } = generateBearerToken();
    expect(token).toMatch(/^imcp_[A-Za-z0-9_-]{43}$/);
    expect(sha256).toBe(hashToken(token));
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the presented token against stored hashes", () => {
    const a = generateBearerToken();
    const b = generateBearerToken();
    const entries = [
      { id: "laptop", sha256: a.sha256 },
      { id: "routine", sha256: b.sha256 },
    ];
    expect(matchBearerToken(b.token, entries)).toBe("routine");
    expect(matchBearerToken("imcp_wrong", entries)).toBeNull();
  });

  it("ignores malformed stored hashes instead of throwing", () => {
    expect(matchBearerToken("x", [{ id: "bad", sha256: "abc" }])).toBeNull();
  });

  it.each([
    ["Bearer imcp_abc", "imcp_abc"],
    ["bearer   imcp_abc", "imcp_abc"],
    ["Basic dXNlcjpwYXNz", null],
    ["Bearer", null],
    ["Bearer a b", null],
    [null, null],
  ])("parses %s", (header, expected) => {
    expect(parseBearerHeader(header)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/transport/__tests__/bearer.test.ts`
Expected: FAIL — `Cannot find module '../auth/bearer.js'`.

- [ ] **Step 3: Implement**

```ts
// src/transport/auth/bearer.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface BearerTokenEntry {
  id: string;
  /** Lowercase hex SHA-256 of the token. The token itself is never stored. */
  sha256: string;
}

export const TOKEN_PREFIX = "imcp_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 256 bits of randomness, URL-safe, recognisable prefix for secret scanners. */
export function generateBearerToken(): { token: string; sha256: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, sha256: hashToken(token) };
}

/** Extract the token from an `Authorization: Bearer <token>` header (RFC 6750 b64token syntax). */
export function parseBearerHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * Compare the presented token's digest with every configured digest in constant time.
 * All entries are always checked so the response time does not reveal which entry matched.
 */
export function matchBearerToken(presented: string, entries: BearerTokenEntry[]): string | null {
  const digest = Buffer.from(hashToken(presented), "hex");
  let matched: string | null = null;
  for (const entry of entries) {
    const expected = Buffer.from(entry.sha256, "hex");
    const equal = expected.length === digest.length && timingSafeEqual(expected, digest);
    if (equal && matched === null) matched = entry.id;
  }
  return matched;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/transport/__tests__/bearer.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transport/auth/bearer.ts src/transport/__tests__/bearer.test.ts
git commit -m "feat(http): hashed bearer tokens with constant-time matching

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Network guards

**Files:**
- Create: `src/transport/guards.ts`
- Test: `src/transport/__tests__/guards.test.ts`

**Interfaces:**
- Produces: `normalizeIp(ip)`, `clientIp(remoteAddress: string | undefined, forwardedFor: string | null, trustedHops: number): string`, `createIpAllowlist(cidrs: string[]): (ip: string) => boolean`, `type TakeResult`, `class RateLimiter { constructor(opts: { capacity; refillPerMinute; now?; maxKeys? }); take(key): TakeResult }`, `withSecurityHeaders(response: Response, opts: { hsts: boolean }): Response`, `jsonResponse(status, body, headers?): Response`.

- [ ] **Step 1: Write the failing test**

```ts
// src/transport/__tests__/guards.test.ts
import { describe, it, expect } from "vitest";
import { RateLimiter, clientIp, createIpAllowlist, withSecurityHeaders } from "../guards.js";

describe("clientIp", () => {
  it("ignores X-Forwarded-For when no proxy is trusted", () => {
    expect(clientIp("203.0.113.9", "1.2.3.4", 0)).toBe("203.0.113.9");
  });

  it("uses the address appended by the trusted proxy, never attacker-supplied entries", () => {
    // attacker sends "X-Forwarded-For: 160.79.104.10"; Caddy appends the real peer 198.51.100.7
    expect(clientIp("172.18.0.2", "160.79.104.10, 198.51.100.7", 1)).toBe("198.51.100.7");
  });

  it("normalises IPv4-mapped IPv6 peers", () => {
    expect(clientIp("::ffff:127.0.0.1", null, 0)).toBe("127.0.0.1");
  });

  it("falls back to the peer address when the forwarded entry is not an IP", () => {
    expect(clientIp("172.18.0.2", "unknown", 1)).toBe("172.18.0.2");
  });
});

describe("createIpAllowlist", () => {
  it("allows everything when empty", () => {
    expect(createIpAllowlist([])("8.8.8.8")).toBe(true);
  });

  it("matches the Anthropic egress range and single addresses", () => {
    const allowed = createIpAllowlist(["160.79.104.0/21", "2001:db8::/32", "10.0.0.5"]);
    expect(allowed("160.79.111.255")).toBe(true);
    expect(allowed("160.79.112.0")).toBe(false);
    expect(allowed("2001:db8::1")).toBe(true);
    expect(allowed("10.0.0.5")).toBe(true);
    expect(allowed("10.0.0.6")).toBe(false);
    expect(allowed("not-an-ip")).toBe(false);
  });

  it("rejects invalid ranges at startup", () => {
    expect(() => createIpAllowlist(["160.79.104.0/33"])).toThrow(/prefix/);
    expect(() => createIpAllowlist(["example.com/24"])).toThrow(/Invalid IP range/);
  });
});

describe("RateLimiter", () => {
  it("allows a burst, then reports Retry-After until tokens refill", () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerMinute: 60, now: () => now });
    expect(limiter.take("p").allowed).toBe(true);
    expect(limiter.take("p").allowed).toBe(true);
    const third = limiter.take("p");
    expect(third).toEqual({ allowed: false, retryAfterSec: 1 });
    now += 1000;
    expect(limiter.take("p").allowed).toBe(true);
    expect(limiter.take("other").allowed).toBe(true);
  });

  it("bounds memory by evicting the oldest key", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerMinute: 1, maxKeys: 2, now: () => 0 });
    limiter.take("a");
    limiter.take("b");
    limiter.take("c");
    expect(limiter.take("a").allowed).toBe(true); // "a" was evicted and starts with a full bucket
  });
});

describe("withSecurityHeaders", () => {
  it("adds headers without consuming a streamed body", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
        controller.close();
      },
    });
    const res = withSecurityHeaders(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }), { hsts: true });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age/);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await res.text()).toBe("data: 1\n\n");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/transport/__tests__/guards.test.ts`
Expected: FAIL — `Cannot find module '../guards.js'`.

- [ ] **Step 3: Implement**

```ts
// src/transport/guards.ts
import { BlockList, isIP } from "node:net";

/** "::ffff:203.0.113.7" → "203.0.113.7"; trims whitespace. */
export function normalizeIp(ip: string): string {
  const value = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return mapped ? mapped[1] : value;
}

/**
 * The client address as seen by the outermost trusted proxy.
 * `trustedHops` = number of reverse proxies in front of this server (0 = ignore X-Forwarded-For).
 * Entries left of the trusted hops are attacker-controlled and are never used.
 */
export function clientIp(remoteAddress: string | undefined, forwardedFor: string | null, trustedHops: number): string {
  const remote = normalizeIp(remoteAddress ?? "");
  if (trustedHops <= 0 || !forwardedFor) return remote;
  const chain = [
    ...forwardedFor
      .split(",")
      .map((part) => normalizeIp(part))
      .filter((part) => part.length > 0),
    remote,
  ];
  const candidate = chain[Math.max(0, chain.length - 1 - trustedHops)];
  return isIP(candidate) ? candidate : remote;
}

/** Build a matcher for CIDR ranges ("160.79.104.0/21", "2001:db8::/32", "10.0.0.5"). Empty list allows all. */
export function createIpAllowlist(cidrs: string[]): (ip: string) => boolean {
  if (cidrs.length === 0) return () => true;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefixText] = cidr.trim().split("/");
    const family = isIP(address);
    if (family === 0) throw new Error(`Invalid IP range "${cidr}" in http.ipAllowlist`);
    const max = family === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? max : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new Error(`Invalid prefix length in "${cidr}" (http.ipAllowlist)`);
    }
    list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return (ip: string) => {
    const value = normalizeIp(ip);
    const family = isIP(value);
    if (family === 4) return list.check(value, "ipv4");
    if (family === 6) return list.check(value, "ipv6");
    return false;
  };
}

export type TakeResult = { allowed: true } | { allowed: false; retryAfterSec: number };

/** Token bucket per key (principal id or client IP). Memory is bounded by `maxKeys` (oldest key evicted). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly perMs: number;

  constructor(
    private readonly opts: { capacity: number; refillPerMinute: number; now?: () => number; maxKeys?: number },
  ) {
    this.perMs = opts.refillPerMinute / 60_000;
  }

  take(key: string): TakeResult {
    const now = (this.opts.now ?? Date.now)();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.opts.capacity, updated: now };
      this.buckets.set(key, bucket);
      if (this.buckets.size > (this.opts.maxKeys ?? 10_000)) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }
    bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + (now - bucket.updated) * this.perMs);
    bucket.updated = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / this.perMs / 1000)) };
  }
}

/** Response headers for an API that is never rendered by a browser. */
export function withSecurityHeaders(response: Response, opts: { hsts: boolean }): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (opts.hsts) headers.set("Strict-Transport-Security", "max-age=31536000");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/transport/__tests__/guards.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transport/guards.ts src/transport/__tests__/guards.test.ts
git commit -m "feat(http): client IP resolution, CIDR allowlist, rate limiter, security headers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Principals and per-request mailbox scoping

**Files:**
- Create: `src/transport/auth/principals.ts`
- Test: `src/transport/__tests__/fake-app.ts`, `src/transport/__tests__/principals.test.ts`, `src/transport/__tests__/audit-principal.test.ts`

**Interfaces:**
- Consumes: `AppContext`, `AccountRuntime`, `ToolCallEvent`, `ToolObserver`, `AccountNotFoundError` from `src/context.ts`; `PermissionTier` from `src/config/schema.ts` (Plan 2); `tierAllowed(account, tier)` from `src/policy/engine.ts` and, in the test, `AuditLog` from `src/audit/audit-log.ts` (Plan 5).
- Produces: `interface Principal { kind: "bearer" | "oauth"; id: string; tokenId?; sub?; email?; groups: string[]; scopes: string[]; clientId?; expiresAt? }`, `interface PrincipalRule { match: { sub?; email?; group?; tokenId? }; accounts: string[] }`, `ruleMatches(rule, principal): boolean`, `allowedAccountIds(principal, rules, allIds): string[]`, `scopeAppContext(app, principal, allowedIds): AppContext` (overrides `accounts`, `observers`, `defaultAccountId`, `resolveAccount`, `anyAccountAllows` — policy-aware via `tierAllowed`, exactly like Plan 5's `createAppContext` —, `shutdown`; inherits everything else; a mailbox the caller may not use raises Plan 2's `AccountNotFoundError` listing only the caller's mailboxes, so existence is never revealed). Audit events gain `details.principal` and `details.principalKind`. Test helper `fakeApp(ids, events?, defaultAccount?): AppContext`.

- [ ] **Step 1: Write the test helper and the failing test**

```ts
// src/transport/__tests__/fake-app.ts
import type { AppContext, ToolCallEvent } from "../../context.js";

/**
 * A minimal AppContext for transport tests: accounts expose only `id`, `config.permissions` and
 * `config.policy.send.mode` (read by Plan 5's tierAllowed), which is all the HTTP layer touches.
 * The account id "drafts" gets the drafts-only send policy. Cast because the real AccountRuntime has many more members.
 */
export function fakeApp(ids: string[], events: ToolCallEvent[] = [], defaultAccount?: string): AppContext {
  const accounts = new Map(
    ids.map((id) => [
      id,
      {
        id,
        config: {
          id,
          email: `${id}@firma.example`,
          permissions: { read: true, write: true, send: id === "office" || id === "drafts", delete: false },
          policy: { send: { mode: id === "drafts" ? "drafts-only" : "confirm" } },
        },
      },
    ]),
  );
  const defaultAccountId = defaultAccount ?? ids[0];
  return {
    config: { defaultAccount, accounts: [...accounts.values()].map((a) => a.config) },
    defaultAccountId,
    accounts,
    observers: [{ onToolCall: (event: ToolCallEvent) => void events.push(event) }],
    resolveAccount(id: string | undefined) {
      const account = accounts.get(id ?? defaultAccountId);
      if (!account) throw new Error(`Unknown account "${id}"`);
      return account;
    },
    anyAccountAllows: (tier: "read" | "write" | "send" | "delete") =>
      [...accounts.values()].some((a) => a.config.permissions[tier] && !(tier === "send" && a.config.policy.send.mode === "drafts-only")),
    shutdown: async () => {},
  } as unknown as AppContext;
}
```

```ts
// src/transport/__tests__/principals.test.ts
import { describe, it, expect } from "vitest";
import type { ToolCallEvent } from "../../context.js";
import { fakeApp } from "./fake-app.js";
import { AccountNotFoundError } from "../../context.js";
import { allowedAccountIds, scopeAppContext, type Principal } from "../auth/principals.js";

const bearer = (tokenId: string): Principal => ({ kind: "bearer", id: `token:${tokenId}`, tokenId, groups: [], scopes: [] });
const oauth = (extra: Partial<Principal>): Principal => ({ kind: "oauth", id: "oauth:u1", sub: "u1", groups: [], scopes: [], ...extra });

describe("allowedAccountIds", () => {
  const all = ["office", "private", "shop"];

  it("gives bearer tokens every account when no rules are configured", () => {
    expect(allowedAccountIds(bearer("laptop"), [], all)).toEqual(all);
  });

  it("gives OAuth principals nothing when no rules are configured", () => {
    expect(allowedAccountIds(oauth({}), [], all)).toEqual([]);
  });

  it("unions matching rules, honours '*' and ignores unknown ids", () => {
    const rules = [
      { match: { email: "max@firma.example" }, accounts: ["office", "ghost"] },
      { match: { group: "g-shop" }, accounts: ["shop"] },
      { match: { tokenId: "routine" }, accounts: ["*"] },
    ];
    expect(allowedAccountIds(oauth({ email: "MAX@firma.example", groups: ["g-shop"] }), rules, all)).toEqual(["office", "shop"]);
    expect(allowedAccountIds(bearer("routine"), rules, all)).toEqual(all);
    expect(allowedAccountIds(bearer("other"), rules, all)).toEqual([]);
  });

  it("requires every key of a match to fit (AND)", () => {
    const rules = [{ match: { email: "max@firma.example", group: "g-admin" }, accounts: ["office"] }];
    expect(allowedAccountIds(oauth({ email: "max@firma.example" }), rules, all)).toEqual([]);
  });
});

describe("scopeAppContext", () => {
  it("hides other mailboxes and refuses them without revealing whether they exist", () => {
    const view = scopeAppContext(fakeApp(["office", "private"], []), oauth({}), ["private"]);
    expect([...view.accounts.keys()]).toEqual(["private"]);
    expect(view.resolveAccount(undefined).id).toBe("private");
    expect(() => view.resolveAccount("office")).toThrow(AccountNotFoundError);
    expect(() => view.resolveAccount("nope")).toThrow('There is no mail account "nope". Available accounts: "private".');
    expect(() => view.resolveAccount("office")).toThrow('There is no mail account "office". Available accounts: "private".');
    expect(view.anyAccountAllows("send")).toBe(false);
  });

  it("falls back to the first allowed mailbox when the configured default is not allowed", () => {
    const view = scopeAppContext(fakeApp(["office", "private", "shop"], [], "office"), oauth({}), ["private", "shop"]);
    expect(view.defaultAccountId).toBe("private");
    expect(view.resolveAccount(undefined).id).toBe("private");
  });

  it("keeps the configured default when it is allowed", () => {
    const view = scopeAppContext(fakeApp(["office", "private", "shop"], [], "shop"), oauth({}), ["private", "shop"]);
    expect(view.defaultAccountId).toBe("shop");
    expect(view.resolveAccount(undefined).id).toBe("shop");
  });

  it("stamps the principal on every audit event", async () => {
    const events: ToolCallEvent[] = [];
    const view = scopeAppContext(fakeApp(["office"], events), bearer("routine"), ["office"]);
    await view.observers[0].onToolCall({ tool: "search_emails", accountId: "office", tier: "read", outcome: "success", durationMs: 3, details: { folder: "INBOX" } });
    expect(events[0].details).toEqual({ folder: "INBOX", principal: "token:routine", principalKind: "bearer" });
  });

  it("uses the policy-aware tier check: a drafts-only mailbox does not enable sending", () => {
    const app = fakeApp(["office", "drafts"], []);
    expect(scopeAppContext(app, bearer("a"), ["drafts"]).anyAccountAllows("send")).toBe(false);
    expect(scopeAppContext(app, bearer("b"), ["office", "drafts"]).anyAccountAllows("send")).toBe(true);
    expect(scopeAppContext(app, bearer("c"), ["drafts"]).anyAccountAllows("write")).toBe(true);
  });

  it("inherits members it does not override", () => {
    const base = fakeApp(["office"], []);
    const view = scopeAppContext(base, bearer("x"), ["office"]);
    expect(view.config).toBe(base.config);
  });
});
```

The audit trail must keep the caller through Plan 5's `sanitizeDetails` at both audit levels — asserted against the real `AuditLog`:

```ts
// src/transport/__tests__/audit-principal.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditLog } from "../../audit/audit-log.js";
import { fakeApp } from "./fake-app.js";
import { scopeAppContext, type Principal } from "../auth/principals.js";

const principal: Principal = { kind: "bearer", id: "token:routine", tokenId: "routine", groups: [], scopes: [] };

function records(dir: string): Array<{ tool: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line));
}

describe("audit trail in HTTP mode", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "imcp-audit-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["standard", "minimal"] as const)("Plan 5's AuditLog keeps the caller (%s level)", async (level) => {
    const app = fakeApp(["office"]);
    const log = new AuditLog({ dir, level, retentionDays: 365, includeReads: false });
    log.ensureWritable();
    app.observers.push(log);

    const view = scopeAppContext(app, principal, ["office"]);
    for (const observer of view.observers) {
      await observer.onToolCall({ tool: "move_email", accountId: "office", tier: "write", outcome: "success", durationMs: 4, details: { folder: "INBOX", uids: [1] } });
    }

    const [record] = records(dir);
    expect(record.tool).toBe("move_email");
    expect(record.details).toMatchObject({ folder: "INBOX", principal: "token:routine", principalKind: "bearer" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/transport/__tests__/principals.test.ts src/transport/__tests__/audit-principal.test.ts`
Expected: FAIL — `Cannot find module '../auth/principals.js'`.

- [ ] **Step 3: Implement**

```ts
// src/transport/auth/principals.ts
import type { PermissionTier } from "../../config/schema.js";
import { AccountNotFoundError, type AccountRuntime, type AppContext, type ToolCallEvent, type ToolObserver } from "../../context.js";
import { tierAllowed } from "../../policy/engine.js";

/** The authenticated caller of the HTTP endpoint. */
export interface Principal {
  kind: "bearer" | "oauth";
  /** Stable id used for rate limiting and the audit log: "token:<id>" or "oauth:<sub>". */
  id: string;
  tokenId?: string;
  sub?: string;
  email?: string;
  groups: string[];
  scopes: string[];
  clientId?: string;
  /** Seconds since epoch. */
  expiresAt?: number;
}

export interface PrincipalRule {
  match: { sub?: string; email?: string; group?: string; tokenId?: string };
  /** Account ids, or "*" for every configured account. */
  accounts: string[];
}

/** Every key present in `match` must match (AND). */
export function ruleMatches(rule: PrincipalRule, principal: Principal): boolean {
  const m = rule.match;
  if (m.tokenId !== undefined && m.tokenId !== principal.tokenId) return false;
  if (m.sub !== undefined && m.sub !== principal.sub) return false;
  if (m.email !== undefined && m.email.toLowerCase() !== principal.email?.toLowerCase()) return false;
  if (m.group !== undefined && !principal.groups.includes(m.group)) return false;
  return true;
}

/**
 * Account ids this principal may use, in configuration order.
 * No rules configured: bearer tokens get every account (the token is the trust anchor);
 * OAuth principals get none (config validation already requires rules in OAuth mode).
 */
export function allowedAccountIds(
  principal: Principal,
  rules: PrincipalRule[],
  allIds: string[],
): string[] {
  if (rules.length === 0) return principal.kind === "bearer" ? [...allIds] : [];
  const allowed = new Set<string>();
  for (const rule of rules) {
    if (!ruleMatches(rule, principal)) continue;
    for (const id of rule.accounts) {
      if (id === "*") allIds.forEach((a) => allowed.add(a));
      else allowed.add(id);
    }
  }
  return allIds.filter((id) => allowed.has(id));
}

/**
 * A per-request view of the shared AppContext: only the allowed accounts are visible, and every
 * audit event carries the principal. Account runtimes (IMAP connections) stay shared.
 * Other AppContext members are inherited from `app` via the prototype chain.
 */
export function scopeAppContext(app: AppContext, principal: Principal, allowedIds: string[]): AppContext {
  const allowed = new Set(allowedIds);
  const accounts = new Map<string, AccountRuntime>([...app.accounts].filter(([id]) => allowed.has(id)));
  const observers: ToolObserver[] = app.observers.map((observer) => ({
    onToolCall: (event: ToolCallEvent) =>
      observer.onToolCall({
        ...event,
        details: { ...event.details, principal: principal.id, principalKind: principal.kind },
      }),
  }));
  // The configured default if this principal may use it, otherwise its first allowed mailbox.
  const defaultAccountId = allowed.has(app.defaultAccountId) ? app.defaultAccountId : [...accounts.keys()][0];

  const overrides = {
    accounts,
    observers,
    defaultAccountId,
    resolveAccount(id: string | undefined): AccountRuntime {
      const wanted = id ?? defaultAccountId;
      // Same error for "exists but not yours" and "does not exist", listing only this caller's accounts.
      if (!allowed.has(wanted)) throw new AccountNotFoundError(wanted, [...accounts.keys()]);
      return app.resolveAccount(wanted);
    },
    anyAccountAllows(tier: PermissionTier): boolean {
      // Same policy-aware check as Plan 5's createAppContext: a drafts-only mailbox never enables send tools.
      return [...accounts.values()].some((a) => tierAllowed(a.config, tier));
    },
    async shutdown(): Promise<void> {
      // Shared account runtimes are owned by the process, not by one request.
    },
  };
  return Object.assign(Object.create(app) as AppContext, overrides);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/transport/__tests__/principals.test.ts src/transport/__tests__/audit-principal.test.ts && npm run typecheck`
Expected: PASS (principals 10, audit-principal 2), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/transport/auth/principals.ts src/transport/__tests__/fake-app.ts src/transport/__tests__/principals.test.ts src/transport/__tests__/audit-principal.test.ts
git commit -m "feat(http): map callers to mailboxes and stamp the principal on audit events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: OAuth access-token verification and protected resource metadata

**Files:**
- Create: `src/transport/auth/oauth.ts`, `src/transport/auth/metadata.ts`
- Test: `src/transport/__tests__/oauth.test.ts`

**Interfaces:**
- Consumes: `Principal` (Task 5), `jsonResponse` (Task 4), `jose` (`createRemoteJWKSet`, `jwtVerify`).
- Produces (`oauth.ts`): `interface OAuthSettings { issuer; audience: string[]; jwksUri?; requiredScopes: string[]; clockToleranceSec; algorithms: string[] }`, `class AuthError { code: "invalid_request" | "invalid_token" | "insufficient_scope"; scope? }`, `authorizationServerMetadataUrl(issuer)`, `openIdConfigurationUrl(issuer)`, `discoverJwksUri(issuer, fetchImpl?)`, `tokenScopes(payload)`, `interface JwtVerifierDeps { keys?: JWTVerifyGetKey; fetch? }`, `createJwtVerifier(settings, deps?): (token: string) => Promise<Principal>`.
- Produces (`metadata.ts`): `MCP_PATH = "/mcp"`, `mcpResourceUrl(publicUrl)`, `protectedResourceMetadataUrl(publicUrl)` (RFC 9728 path-aware), `isProtectedResourceMetadataPath(pathname)`, `interface ProtectedResourceMetadata`, `buildProtectedResourceMetadata({ publicUrl, issuer, scopes, resourceName? })`, `bearerChallenge(params)`, `metadataResponse(doc)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/transport/__tests__/oauth.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import {
  AuthError,
  authorizationServerMetadataUrl,
  createJwtVerifier,
  discoverJwksUri,
  type OAuthSettings,
} from "../auth/oauth.js";
import {
  bearerChallenge,
  buildProtectedResourceMetadata,
  isProtectedResourceMetadataPath,
  protectedResourceMetadataUrl,
} from "../auth/metadata.js";

const ISSUER = "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0";
const API_GUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const settings: OAuthSettings = {
  issuer: ISSUER,
  audience: [API_GUID, `api://${API_GUID}`],
  requiredScopes: ["mail.access"],
  clockToleranceSec: 60,
  algorithms: ["RS256", "PS256", "ES256"],
};

let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;

async function token(claims: Record<string, unknown>, opts: { aud?: string; exp?: string; kid?: string; iss?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: opts.kid ?? "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? API_GUID)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey as CryptoKey;
  const jwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] });
});

describe("createJwtVerifier", () => {
  it("accepts an Entra-style token (scp claim, GUID audience) and builds the principal", async () => {
    const verify = createJwtVerifier(settings, { keys });
    const principal = await verify(await token({ scp: "mail.access other", preferred_username: "Max@Firma.example", groups: ["g-mail"], azp: "client-1" }));
    expect(principal).toMatchObject({
      kind: "oauth",
      id: "oauth:user-1",
      email: "Max@Firma.example",
      groups: ["g-mail"],
      clientId: "client-1",
    });
    expect(principal.scopes).toEqual(["mail.access", "other"]);
  });

  it("accepts the api:// audience form and app roles", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify(await token({ roles: ["mail.access"] }, { aud: `api://${API_GUID}` }))).resolves.toMatchObject({ sub: "user-1" });
  });

  it("rejects a token for another audience as invalid_token", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify(await token({ scp: "mail.access" }, { aud: "https://graph.microsoft.com" }))).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects an expired token and an unknown key id with invalid_token, not a crash", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify(await token({ scp: "mail.access" }, { exp: "-10m" }))).rejects.toMatchObject({ code: "invalid_token", message: expect.stringMatching(/expired/) });
    await expect(verify(await token({ scp: "mail.access" }, { kid: "rotated" }))).rejects.toBeInstanceOf(AuthError);
  });

  it("reports missing scopes as insufficient_scope", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify(await token({ scp: "other" }))).rejects.toMatchObject({ code: "insufficient_scope", scope: "mail.access" });
  });

  it("rejects garbage", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify("not.a.jwt")).rejects.toMatchObject({ code: "invalid_token" });
  });
});

describe("discoverJwksUri", () => {
  it("uses OIDC discovery and requires the issuer to match", async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith("/openid-configuration")
        ? new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: "https://login.microsoftonline.com/keys" }))
        : new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await discoverJwksUri(ISSUER, fetchImpl)).toBe("https://login.microsoftonline.com/keys");
  });

  it("fails clearly when no document matches", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ issuer: "https://evil.example", jwks_uri: "x" }))) as unknown as typeof fetch;
    await expect(discoverJwksUri(ISSUER, fetchImpl)).rejects.toThrow(/httpAuth\.jwksUri/);
  });

  it("builds the RFC 8414 location with the issuer path appended", () => {
    expect(authorizationServerMetadataUrl("https://idp.example/realms/kmu")).toBe(
      "https://idp.example/.well-known/oauth-authorization-server/realms/kmu",
    );
  });
});

describe("protected resource metadata", () => {
  it("builds the RFC 9728 document and the path-aware URL", () => {
    expect(buildProtectedResourceMetadata({ publicUrl: "https://mail.example.com", issuer: ISSUER, scopes: ["mail.access"] })).toEqual({
      resource: "https://mail.example.com/mcp",
      authorization_servers: [ISSUER],
      scopes_supported: ["mail.access"],
      bearer_methods_supported: ["header"],
      resource_name: "imap-smtp-mcp",
    });
    expect(protectedResourceMetadataUrl("https://mail.example.com")).toBe(
      "https://mail.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(isProtectedResourceMetadataPath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isProtectedResourceMetadataPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
  });

  it("formats WWW-Authenticate challenges and strips quotes", () => {
    expect(bearerChallenge({ resource_metadata: "https://x/.well-known/oauth-protected-resource/mcp", error: "invalid_token", error_description: 'bad "token"' })).toBe(
      'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="bad token"',
    );
    expect(bearerChallenge({})).toBe("Bearer");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/transport/__tests__/oauth.test.ts`
Expected: FAIL — `Cannot find module '../auth/oauth.js'`.

- [ ] **Step 3: Implement the metadata helpers**

```ts
// src/transport/auth/metadata.ts
import { jsonResponse } from "../guards.js";

export const MCP_PATH = "/mcp";
const PRM_ROOT = "/.well-known/oauth-protected-resource";

/** The protected resource identifier (RFC 8707/9728): the MCP endpoint URL. `publicUrl` is an origin. */
export function mcpResourceUrl(publicUrl: string): string {
  return new URL(MCP_PATH, publicUrl).toString();
}

/** RFC 9728 path-aware metadata URL: https://host/.well-known/oauth-protected-resource/mcp */
export function protectedResourceMetadataUrl(publicUrl: string): string {
  return new URL(PRM_ROOT + MCP_PATH, publicUrl).toString();
}

/** Both the path-aware and the root form are served with the same document. */
export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname === PRM_ROOT || pathname === PRM_ROOT + MCP_PATH;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ["header"];
  resource_name: string;
}

export function buildProtectedResourceMetadata(opts: {
  publicUrl: string;
  issuer: string;
  scopes: string[];
  resourceName?: string;
}): ProtectedResourceMetadata {
  return {
    resource: mcpResourceUrl(opts.publicUrl),
    authorization_servers: [opts.issuer],
    scopes_supported: opts.scopes,
    bearer_methods_supported: ["header"],
    resource_name: opts.resourceName ?? "imap-smtp-mcp",
  };
}

/** `Bearer key="value", …` — quotes and backslashes are stripped from values. */
export function bearerChallenge(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}="${value.replace(/["\\]/g, "")}"`);
  return parts.length > 0 ? `Bearer ${parts.join(", ")}` : "Bearer";
}

export function metadataResponse(doc: ProtectedResourceMetadata): Response {
  // Public, secret-free document: allow browser-based MCP clients to read it.
  return jsonResponse(200, doc, { "Access-Control-Allow-Origin": "*" });
}
```

- [ ] **Step 4: Implement the verifier**

```ts
// src/transport/auth/oauth.ts
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Principal } from "./principals.js";

export interface OAuthSettings {
  issuer: string;
  audience: string[];
  jwksUri?: string;
  requiredScopes: string[];
  clockToleranceSec: number;
  algorithms: string[];
}

export class AuthError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_token" | "insufficient_scope",
    message: string,
    readonly scope?: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** RFC 8414 location: the well-known segment goes between host and issuer path. */
export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

export function openIdConfigurationUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
}

/** Find jwks_uri via OIDC discovery, then RFC 8414. The document's issuer must match exactly. */
export async function discoverJwksUri(issuer: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  for (const url of [openIdConfigurationUrl(issuer), authorizationServerMetadataUrl(issuer)]) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const doc = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
      if (doc.issuer === issuer && typeof doc.jwks_uri === "string") return doc.jwks_uri;
    } catch {
      // try the next discovery location
    }
  }
  throw new Error(`Could not discover the signing keys of ${issuer}. Set httpAuth.jwksUri explicitly.`);
}

/** Scopes from `scope`/`scp` (space-separated string or array) plus Entra app `roles`. */
export function tokenScopes(payload: JWTPayload): string[] {
  const scopes = new Set<string>();
  for (const claim of ["scope", "scp"]) {
    const value = payload[claim];
    if (typeof value === "string") value.split(" ").filter(Boolean).forEach((s) => scopes.add(s));
    else if (Array.isArray(value)) value.forEach((s) => typeof s === "string" && scopes.add(s));
  }
  const roles = payload.roles;
  if (Array.isArray(roles)) roles.forEach((r) => typeof r === "string" && scopes.add(r));
  return [...scopes];
}

function firstString(payload: JWTPayload, claims: string[]): string | undefined {
  for (const claim of claims) {
    const value = payload[claim];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function describe(err: unknown): string {
  const code = (err as { code?: string }).code;
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return "The access token has expired.";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      return "The access token was issued for a different server or issuer.";
    case "ERR_JWKS_NO_MATCHING_KEY":
      return "The access token was signed with an unknown key.";
    default:
      return "The access token is invalid.";
  }
}

export interface JwtVerifierDeps {
  /** Injected key resolver (tests: jose createLocalJWKSet). */
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
}

/**
 * Validate access tokens issued by an external IdP (Entra ID, Google, Keycloak, …).
 * Throws AuthError for token problems; other errors (IdP unreachable) propagate as-is.
 */
export function createJwtVerifier(settings: OAuthSettings, deps: JwtVerifierDeps = {}) {
  let keys = deps.keys;
  async function getKeys(): Promise<JWTVerifyGetKey> {
    if (!keys) {
      const uri = settings.jwksUri ?? (await discoverJwksUri(settings.issuer, deps.fetch));
      keys = createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
    }
    return keys;
  }

  return async function verify(token: string): Promise<Principal> {
    const resolver = await getKeys();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, resolver, {
        issuer: settings.issuer,
        audience: settings.audience,
        clockTolerance: settings.clockToleranceSec,
        algorithms: settings.algorithms,
        requiredClaims: ["exp", "sub"],
      }));
    } catch (err) {
      throw new AuthError("invalid_token", describe(err));
    }
    const scopes = tokenScopes(payload);
    const missing = settings.requiredScopes.filter((s) => !scopes.includes(s));
    if (missing.length > 0) {
      throw new AuthError("insufficient_scope", `The access token lacks the scope(s): ${missing.join(" ")}.`, settings.requiredScopes.join(" "));
    }
    return {
      kind: "oauth",
      id: `oauth:${payload.sub}`,
      sub: payload.sub,
      email: firstString(payload, ["email", "preferred_username", "upn"]),
      groups: stringArray(payload.groups),
      scopes,
      clientId: firstString(payload, ["azp", "appid", "client_id"]),
      expiresAt: payload.exp,
    };
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/transport/__tests__/oauth.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add src/transport/auth/oauth.ts src/transport/auth/metadata.ts src/transport/__tests__/oauth.test.ts
git commit -m "feat(http): validate IdP access tokens with jose and publish RFC 9728 metadata

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: HTTP authenticators

**Files:**
- Create: `src/transport/auth/authenticator.ts`
- Test: `src/transport/__tests__/authenticator.test.ts`

**Interfaces:**
- Consumes: `HttpAuthConfig` (Task 2), `matchBearerToken`, `parseBearerHeader` (Task 3), `jsonResponse` (Task 4), `Principal` (Task 5), `AuthError`, `createJwtVerifier`, `JwtVerifierDeps`, `bearerChallenge`, `protectedResourceMetadataUrl` (Task 6).
- Produces: `interface HttpAuthenticator { mode: "bearer" | "oauth"; authenticate(authorization: string | null): Promise<Principal>; challenge(error: AuthError): Response }`, `createHttpAuthenticator(auth: HttpAuthConfig, publicUrl: string | undefined, deps?: JwtVerifierDeps): HttpAuthenticator`.

- [ ] **Step 1: Write the failing test**

```ts
// src/transport/__tests__/authenticator.test.ts
import { describe, it, expect } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { HttpAuthSchema } from "../../config/http-schema.js";
import { createHttpAuthenticator } from "../auth/authenticator.js";
import { generateBearerToken } from "../auth/bearer.js";
import { AuthError } from "../auth/oauth.js";

describe("bearer authenticator", () => {
  const { token, sha256 } = generateBearerToken();
  const auth = createHttpAuthenticator(HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "laptop", sha256 }] }), undefined);

  it("maps a valid token to a bearer principal", async () => {
    expect(await auth.authenticate(`Bearer ${token}`)).toEqual({ kind: "bearer", id: "token:laptop", tokenId: "laptop", groups: [], scopes: [] });
  });

  it("distinguishes missing credentials from bad ones", async () => {
    await expect(auth.authenticate(null)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(auth.authenticate("Bearer imcp_nope")).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("omits the error code when no credentials were sent (RFC 6750 §3.1)", () => {
    const res = auth.challenge(new AuthError("invalid_request", "Missing bearer token."));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="imap-smtp-mcp"');
  });
});

describe("OAuth authenticator", () => {
  it("challenges with resource_metadata and maps insufficient_scope to 403", async () => {
    const pair = await generateKeyPair("ES256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256" }] });
    const config = HttpAuthSchema.parse({
      mode: "oauth",
      issuer: "https://idp.example",
      audience: "api",
      requiredScopes: ["mail.access"],
      principals: [{ match: { sub: "u" }, accounts: ["main"] }],
    });
    const auth = createHttpAuthenticator(config, "https://mail.example.com", { keys });

    const missing = auth.challenge(new AuthError("invalid_request", "Missing bearer token."));
    expect(missing.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://mail.example.com/.well-known/oauth-protected-resource/mcp"');

    const jwt = await new SignJWT({ scope: "profile" })
      .setProtectedHeader({ alg: "ES256", kid: "k" })
      .setIssuer("https://idp.example")
      .setAudience("api")
      .setSubject("u")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    const error = await auth.authenticate(`Bearer ${jwt}`).catch((e: AuthError) => e);
    expect(error).toBeInstanceOf(AuthError);
    const res = auth.challenge(error as AuthError);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(res.headers.get("www-authenticate")).toContain('scope="mail.access"');
  });

  it("refuses to build without a publicUrl", () => {
    const config = HttpAuthSchema.parse({ mode: "oauth", issuer: "https://idp.example", audience: "api", principals: [{ match: { sub: "u" }, accounts: ["main"] }] });
    expect(() => createHttpAuthenticator(config, undefined)).toThrow(/publicUrl/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/transport/__tests__/authenticator.test.ts`
Expected: FAIL — `Cannot find module '../auth/authenticator.js'`.

- [ ] **Step 3: Implement**

```ts
// src/transport/auth/authenticator.ts
import type { HttpAuthConfig } from "../../config/http-schema.js";
import { jsonResponse } from "../guards.js";
import { matchBearerToken, parseBearerHeader } from "./bearer.js";
import { bearerChallenge, protectedResourceMetadataUrl } from "./metadata.js";
import { AuthError, createJwtVerifier, type JwtVerifierDeps } from "./oauth.js";
import type { Principal } from "./principals.js";

export interface HttpAuthenticator {
  readonly mode: "bearer" | "oauth";
  /** Throws AuthError for missing/invalid credentials; other errors mean "auth backend unavailable". */
  authenticate(authorization: string | null): Promise<Principal>;
  /** 401 (or 403 for insufficient_scope) with an RFC 6750 WWW-Authenticate header. */
  challenge(error: AuthError): Response;
}

function challengeResponse(error: AuthError, params: Record<string, string | undefined>): Response {
  const status = error.code === "insufficient_scope" ? 403 : 401;
  // RFC 6750 §3.1: no error code when the request carried no credentials at all
  const withError = error.code === "invalid_request" ? params : { ...params, error: error.code, error_description: error.message, scope: error.scope };
  return jsonResponse(status, { error: error.code, error_description: error.message }, { "WWW-Authenticate": bearerChallenge(withError) });
}

export function createHttpAuthenticator(auth: HttpAuthConfig, publicUrl: string | undefined, deps: JwtVerifierDeps = {}): HttpAuthenticator {
  if (auth.mode === "bearer") {
    return {
      mode: "bearer",
      async authenticate(authorization) {
        const token = parseBearerHeader(authorization);
        if (!token) throw new AuthError("invalid_request", "Missing bearer token.");
        const tokenId = matchBearerToken(token, auth.tokens);
        if (!tokenId) throw new AuthError("invalid_token", "Unknown or revoked token.");
        return { kind: "bearer", id: `token:${tokenId}`, tokenId, groups: [], scopes: [] };
      },
      challenge: (error) => challengeResponse(error, { realm: "imap-smtp-mcp" }),
    };
  }

  if (!publicUrl) throw new Error("OAuth mode requires http.publicUrl.");
  const verify = createJwtVerifier(
    {
      issuer: auth.issuer,
      audience: auth.audience,
      jwksUri: auth.jwksUri,
      requiredScopes: auth.requiredScopes,
      clockToleranceSec: auth.clockToleranceSec,
      algorithms: auth.algorithms,
    },
    deps,
  );
  const resourceMetadata = protectedResourceMetadataUrl(publicUrl);
  return {
    mode: "oauth",
    async authenticate(authorization) {
      const token = parseBearerHeader(authorization);
      if (!token) throw new AuthError("invalid_request", "Missing bearer token.");
      return verify(token);
    },
    challenge: (error) => challengeResponse(error, { resource_metadata: resourceMetadata }),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/transport/__tests__/authenticator.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transport/auth/authenticator.ts src/transport/__tests__/authenticator.test.ts
git commit -m "feat(http): bearer and OAuth authenticators with RFC 6750 challenges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: HTTP router and Node server

**Files:**
- Create: `src/transport/http-app.ts`, `src/transport/http-server.ts`
- Test: `src/transport/__tests__/http-e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7; `createMcpHandler`, `hostHeaderValidationResponse`, `originValidationResponse`, `localhostAllowedHostnames`, `AuthInfo`, `McpServer` from `@modelcontextprotocol/server`; `getRequestListener`, `HttpBindings` from `@hono/node-server`; `log` from `src/logging/logger.ts`.
- Produces: `interface HttpAppOptions { app; http; auth; principals; createServer(app): McpServer; metadata?; now? }`, `interface HttpApp { fetch(request: Request, remoteAddress: string | undefined): Promise<Response>; close(): Promise<void> }`, `allowedHostnames(http): string[]`, `createHttpApp(opts): HttpApp`; `interface RunningHttpServer { url; port; close() }`, `startHttpServer(httpApp, { host, port, requestTimeoutMs }): Promise<RunningHttpServer>`.
- Routes: `GET /healthz` (no auth, no data, loopback Host always accepted), `GET /.well-known/oauth-protected-resource[/mcp]` (OAuth mode only), `/mcp` (Host → Origin → IP allowlist → declared size → auth → principal mapping → rate limit → SDK handler with `authInfo.extra = { principal, accounts }`), everything else 404.

- [ ] **Step 1: Write the failing end-to-end test**

```ts
// src/transport/__tests__/http-e2e.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { request as httpRequest } from "node:http";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { AppContext, ToolCallEvent } from "../../context.js";
import { fakeApp } from "./fake-app.js";
import { HttpAuthSchema, HttpSchema } from "../../config/http-schema.js";
import { generateBearerToken } from "../auth/bearer.js";
import { createHttpAuthenticator } from "../auth/authenticator.js";
import { buildProtectedResourceMetadata } from "../auth/metadata.js";
import { createHttpApp, type HttpApp } from "../http-app.js";
import { startHttpServer, type RunningHttpServer } from "../http-server.js";

/** Stands in for createServer(app): one tool that reveals which mailbox a call resolves to. */
function createServer(app: AppContext): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "whoami",
    { title: "Who am I", description: "test", inputSchema: z.object({ account: z.string().optional() }) },
    async ({ account }) => {
      const resolved = app.resolveAccount(account);
      await Promise.all(app.observers.map((o) => o.onToolCall({ tool: "whoami", accountId: resolved.id, tier: "read", outcome: "success", durationMs: 0, details: {} })));
      return { content: [{ type: "text", text: resolved.id }] };
    },
  );
  return server;
}

async function mcpClient(url: string, authorization?: string) {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: authorization ? { headers: { Authorization: authorization } } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** fetch() cannot set Host (undici overrides it); node:http can. */
function rawPost(url: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

function text(result: unknown): string {
  return ((result as { content: Array<{ text?: string }> }).content[0]?.text ?? "") as string;
}

describe("HTTP transport with bearer tokens", () => {
  const events: ToolCallEvent[] = [];
  const office = generateBearerToken();
  const routine = generateBearerToken();
  let httpApp: HttpApp;
  let running: RunningHttpServer;

  beforeAll(async () => {
    const http = HttpSchema.parse({ port: 0, maxBodyBytes: 64 * 1024, rateLimit: { perMinute: 600, burst: 100 } });
    const httpAuth = HttpAuthSchema.parse({
      mode: "bearer",
      tokens: [
        { id: "office", sha256: office.sha256 },
        { id: "routine", sha256: routine.sha256 },
      ],
      principals: [{ match: { tokenId: "routine" }, accounts: ["shop"] }, { match: { tokenId: "office" }, accounts: ["*"] }],
    });
    httpApp = createHttpApp({
      app: fakeApp(["office", "shop"], events),
      http,
      auth: createHttpAuthenticator(httpAuth, undefined),
      principals: httpAuth.principals,
      createServer,
    });
    running = await startHttpServer(httpApp, { host: "127.0.0.1", port: 0, requestTimeoutMs: 10_000 });
  });

  afterAll(async () => {
    await running.close();
    await httpApp.close();
  });

  it("serves /healthz without credentials and without data", async () => {
    const res = await fetch(`${running.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects /mcp without a token with 401 and a Bearer challenge", async () => {
    const res = await fetch(`${running.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="imap-smtp-mcp"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects a wrong token with error=invalid_token", async () => {
    const res = await fetch(`${running.url}/mcp`, { method: "POST", headers: { Authorization: "Bearer imcp_wrong", "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
  });

  it("serves MCP to a valid token and scopes mailboxes per token", async () => {
    const officeClient = await mcpClient(running.url, `Bearer ${office.token}`);
    expect(text(await officeClient.callTool({ name: "whoami", arguments: { account: "shop" } }))).toBe("shop");
    await officeClient.close();

    const routineClient = await mcpClient(running.url, `Bearer ${routine.token}`);
    expect(text(await routineClient.callTool({ name: "whoami", arguments: {} }))).toBe("shop");
    const denied = await routineClient.callTool({ name: "whoami", arguments: { account: "office" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/There is no mail account "office". Available accounts: "shop"/);
    await routineClient.close();
  });

  it("stamps the principal on audit events", () => {
    expect(events.some((e) => e.details.principal === "token:routine")).toBe(true);
  });

  it("blocks DNS rebinding (foreign Host) before authentication", async () => {
    expect(await rawPost(running.url, { Host: "attacker.example", Authorization: `Bearer ${office.token}` }, "{}")).toBe(403);
    expect(await rawPost(running.url, { Host: "127.0.0.1.nip.io", Authorization: `Bearer ${office.token}` }, "{}")).toBe(403);
  });

  it("blocks browser requests from foreign origins", async () => {
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { Origin: "https://evil.example", Authorization: `Bearer ${office.token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("answers 413 for an oversized body before authentication", async () => {
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it("answers 404 for unknown paths and for metadata in bearer mode", async () => {
    expect((await fetch(`${running.url}/admin`)).status).toBe(404);
    expect((await fetch(`${running.url}/.well-known/oauth-protected-resource`)).status).toBe(404);
  });
});

describe("HTTP transport with OAuth (resource server)", () => {
  const ISSUER = "https://idp.example/realms/kmu";
  const PUBLIC = "http://127.0.0.1"; // loopback publicUrl is allowed for local testing
  let privateKey: CryptoKey;
  let httpApp: HttpApp;
  let running: RunningHttpServer;

  const sign = (claims: Record<string, unknown>, aud = "imap-mcp") =>
    new SignJWT(claims).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(ISSUER).setAudience(aud).setSubject("u1").setIssuedAt().setExpirationTime("5m").sign(privateKey);

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey as CryptoKey;
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" }] });
    const http = HttpSchema.parse({ port: 0, publicUrl: PUBLIC });
    const httpAuth = HttpAuthSchema.parse({
      mode: "oauth",
      issuer: ISSUER,
      audience: "imap-mcp",
      requiredScopes: ["mail.access"],
      principals: [{ match: { group: "g-mail" }, accounts: ["office"] }],
    });
    httpApp = createHttpApp({
      app: fakeApp(["office", "shop"], []),
      http,
      auth: createHttpAuthenticator(httpAuth, PUBLIC, { keys }),
      principals: httpAuth.principals,
      createServer,
      metadata: buildProtectedResourceMetadata({ publicUrl: PUBLIC, issuer: ISSUER, scopes: ["mail.access"] }),
    });
    running = await startHttpServer(httpApp, { host: "127.0.0.1", port: 0, requestTimeoutMs: 10_000 });
  });

  afterAll(async () => {
    await running.close();
    await httpApp.close();
  });

  it("publishes protected resource metadata and points 401s at it", async () => {
    const doc = await (await fetch(`${running.url}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(doc).toMatchObject({ resource: "http://127.0.0.1/mcp", authorization_servers: [ISSUER] });
    const res = await fetch(`${running.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"');
  });

  it("lets a user in the mapped group use their mailbox", async () => {
    const client = await mcpClient(running.url, `Bearer ${await sign({ scope: "mail.access", groups: ["g-mail"] })}`);
    expect(text(await client.callTool({ name: "whoami", arguments: {} }))).toBe("office");
    await client.close();
  });

  it("returns 403 for a valid user without a mailbox mapping", async () => {
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await sign({ scope: "mail.access", groups: ["g-other"] })}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 insufficient_scope when the scope is missing", async () => {
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await sign({ scope: "profile", groups: ["g-mail"] })}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toMatch(/error="insufficient_scope", .*scope="mail.access"/);
  });

  it("rejects a token minted for another API", async () => {
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await sign({ scope: "mail.access", groups: ["g-mail"] }, "https://graph.microsoft.com")}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/transport/__tests__/http-e2e.test.ts`
Expected: FAIL — `Cannot find module '../http-app.js'`.

- [ ] **Step 3: Implement the router**

```ts
// src/transport/http-app.ts
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
  type AuthInfo,
  type McpServer,
} from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import type { HttpConfig } from "../config/http-schema.js";
import { isLoopback } from "../connection-security.js";
import * as log from "../logging/logger.js";
import { RateLimiter, clientIp, createIpAllowlist, jsonResponse, withSecurityHeaders } from "./guards.js";
import type { HttpAuthenticator } from "./auth/authenticator.js";
import { isProtectedResourceMetadataPath, metadataResponse, MCP_PATH, type ProtectedResourceMetadata } from "./auth/metadata.js";
import { AuthError } from "./auth/oauth.js";
import { allowedAccountIds, scopeAppContext, type Principal, type PrincipalRule } from "./auth/principals.js";

export interface HttpAppOptions {
  app: AppContext;
  http: HttpConfig;
  auth: HttpAuthenticator;
  principals: PrincipalRule[];
  /** Builds the MCP server for one request from the (principal-scoped) context. */
  createServer: (app: AppContext) => McpServer;
  /** RFC 9728 document, OAuth mode only. */
  metadata?: ProtectedResourceMetadata;
  now?: () => number;
}

export interface HttpApp {
  fetch(request: Request, remoteAddress: string | undefined): Promise<Response>;
  close(): Promise<void>;
}

function trustedHops(trustProxy: boolean | number): number {
  if (trustProxy === true) return 1;
  if (trustProxy === false) return 0;
  return trustProxy;
}

export function allowedHostnames(http: HttpConfig): string[] {
  const names = new Set(http.allowedHosts.map((h) => h.toLowerCase()));
  if (http.publicUrl) names.add(new URL(http.publicUrl).hostname.toLowerCase());
  if (isLoopback(http.host)) localhostAllowedHostnames().forEach((h) => names.add(h));
  return [...names];
}

const HEALTH_HOSTS = localhostAllowedHostnames();

export function createHttpApp(opts: HttpAppOptions): HttpApp {
  const { http, auth } = opts;
  const now = opts.now ?? Date.now;
  const hops = trustedHops(http.trustProxy);
  const ipAllowed = createIpAllowlist(http.ipAllowlist);
  const hostnames = allowedHostnames(http);
  const authFailures = new RateLimiter({ capacity: http.rateLimit.authFailuresPerMinute, refillPerMinute: http.rateLimit.authFailuresPerMinute, now });
  const perPrincipal = new RateLimiter({ capacity: http.rateLimit.burst, refillPerMinute: http.rateLimit.perMinute, now });
  const accountIds = () => [...opts.app.accounts.keys()];

  const mcp = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as { principal?: Principal; accounts?: string[] } | undefined;
      if (!extra?.principal || !extra.accounts) throw new Error("Unauthenticated request reached the MCP handler.");
      return opts.createServer(scopeAppContext(opts.app, extra.principal, extra.accounts));
    },
    {
      legacy: "stateless",
      maxRequestBodySize: http.maxBodyBytes,
      onerror: (error) => log.warn("http.mcp_error", { error: error.message }),
    },
  );

  function tooMany(retryAfterSec: number): Response {
    return jsonResponse(429, { error: "rate_limited" }, { "Retry-After": String(retryAfterSec) });
  }

  async function route(request: Request, remoteAddress: string | undefined): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      const rejected = hostHeaderValidationResponse(request, [...hostnames, ...HEALTH_HOSTS]);
      if (rejected) return rejected;
      return request.method === "GET" ? jsonResponse(200, { status: "ok" }) : jsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET" });
    }

    const hostRejected = hostHeaderValidationResponse(request, hostnames);
    if (hostRejected) return hostRejected;

    if (isProtectedResourceMetadataPath(url.pathname)) {
      if (!opts.metadata) return jsonResponse(404, { error: "not_found" });
      return request.method === "GET" ? metadataResponse(opts.metadata) : jsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET" });
    }

    if (url.pathname !== MCP_PATH) return jsonResponse(404, { error: "not_found" });

    const originRejected = originValidationResponse(request, http.allowedOrigins);
    if (originRejected) return originRejected;

    const ip = clientIp(remoteAddress, request.headers.get("x-forwarded-for"), hops);
    if (!ipAllowed(ip)) {
      log.warn("http.ip_rejected", { ip });
      return jsonResponse(403, { error: "forbidden" });
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    // Connection: close — the unread body must not poison a reused keep-alive socket
    if (declaredLength > http.maxBodyBytes) return jsonResponse(413, { error: "payload_too_large" }, { Connection: "close" });

    let principal: Principal;
    try {
      principal = await auth.authenticate(request.headers.get("authorization"));
    } catch (error) {
      if (error instanceof AuthError) {
        // Missing credentials are the normal discovery step of OAuth clients; only count bad ones.
        if (error.code !== "invalid_request") {
          const limited = authFailures.take(`ip:${ip}`);
          if (!limited.allowed) return tooMany(limited.retryAfterSec);
          log.warn("http.auth_failed", { ip, code: error.code });
        }
        return auth.challenge(error);
      }
      log.error("http.auth_unavailable", {}, error);
      return jsonResponse(503, { error: "temporarily_unavailable" }, { "Retry-After": "30" });
    }

    const accounts = allowedAccountIds(principal, opts.principals, accountIds());
    if (accounts.length === 0) {
      log.warn("http.no_accounts", { principal: principal.id });
      return jsonResponse(403, { error: "forbidden", error_description: "No mailbox is assigned to this identity." });
    }

    const limited = perPrincipal.take(principal.id);
    if (!limited.allowed) return tooMany(limited.retryAfterSec);

    const authInfo: AuthInfo = {
      token: "[redacted]",
      clientId: principal.clientId ?? principal.id,
      scopes: principal.scopes,
      expiresAt: principal.expiresAt,
      extra: { principal, accounts },
    };
    return mcp.fetch(request, { authInfo });
  }

  const hsts = http.publicUrl?.startsWith("https://") ?? false;
  return {
    async fetch(request, remoteAddress) {
      try {
        return withSecurityHeaders(await route(request, remoteAddress), { hsts });
      } catch (error) {
        log.error("http.unhandled", {}, error);
        return withSecurityHeaders(jsonResponse(500, { error: "internal_error" }), { hsts });
      }
    },
    close: () => mcp.close(),
  };
}
```

- [ ] **Step 4: Implement the Node server adapter**

```ts
// src/transport/http-server.ts
import { createServer } from "node:http";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import type { HttpApp } from "./http-app.js";

export interface RunningHttpServer {
  /** e.g. http://127.0.0.1:8787 */
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startHttpServer(
  httpApp: HttpApp,
  opts: { host: string; port: number; requestTimeoutMs: number },
): Promise<RunningHttpServer> {
  const listener = getRequestListener(
    (request, env) => httpApp.fetch(request, (env as HttpBindings).incoming.socket.remoteAddress),
    { overrideGlobalObjects: false },
  );
  const server = createServer(listener);
  server.requestTimeout = opts.requestTimeoutMs; // time to receive the full request
  server.headersTimeout = 15_000; // slowloris protection
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/transport/__tests__/http-e2e.test.ts && npm run typecheck`
Expected: PASS (14 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/transport/http-app.ts src/transport/http-server.ts src/transport/__tests__/http-e2e.test.ts
git commit -m "feat(http): Streamable HTTP endpoint with host/origin/IP checks, auth and per-caller scoping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Container secrets

**Files:**
- Create: `src/secrets/container.ts`
- Modify: `src/serve.ts` (stdio start-up; Plan 2's `src/index.ts` after Plan 6's move), `src/cli/run.ts` (Plan 4's `defaultCliDeps`, which Plan 4 marks for exactly this: "Containers (Plan 7) replace `CliDeps.createSecrets`")
- Test: `src/secrets/__tests__/container.test.ts`

**Interfaces:**
- Consumes: `createSecretStore(env, { keychain: false })` (returns a `ChainSecretStore` over `EnvSecretStore`, which also resolves `IMAP_MCP_PASSWORD_<ID>_FILE`), `SecretKey`, `SecretStore` from `src/secrets/store.ts` (Plan 2).
- Produces: `isContainerMode(env?)`, `applyFileSecrets(env, readFile?): string[]`, `class EncryptedFileSecretStore implements SecretStore` (AES-256-GCM, `$IMAP_MCP_HOME/secrets.enc.json`, mode 0600, atomic rename), `class ContainerSecretStore implements SecretStore` (state file first, then env), `createContainerSecretStore(env?)`, `createRuntimeSecretStore(env?): SecretStore` (container → container store; otherwise Plan 2's env + keychain chain). Every entry point that opens secrets — `serve` (stdio), `serve --http` (Task 10), `http token` (Task 10) and Plan 4's admin CLI (`setup`, `doctor`, `accounts login`, via `CliDeps.createSecrets`) — obtains its store from `createRuntimeSecretStore`, so `accounts login <id> --no-browser` inside the container stores the refresh token in the encrypted state file, never in a keychain.

- [ ] **Step 1: Write the failing test**

```ts
// src/secrets/__tests__/container.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createSecretStore } from "../store.js";
import {
  ContainerSecretStore,
  EncryptedFileSecretStore,
  applyFileSecrets,
  createContainerSecretStore,
  createRuntimeSecretStore,
  isContainerMode,
} from "../container.js";

describe("applyFileSecrets", () => {
  it("fills IMAP_MCP_* from *_FILE and keeps explicit values", () => {
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_STATE_KEY_FILE: "/run/secrets/state_key",
      IMAP_MCP_SMTP_HOST_FILE: "/run/secrets/ignored",
      IMAP_MCP_SMTP_HOST: "smtp.example.com",
      OTHER_FILE: "/etc/passwd",
    };
    const files: Record<string, string> = { "/run/secrets/state_key": "a2V5\n", "/run/secrets/ignored": "x" };
    expect(applyFileSecrets(env, (f) => files[f])).toEqual(["IMAP_MCP_STATE_KEY"]);
    expect(env.IMAP_MCP_STATE_KEY).toBe("a2V5");
    expect(env.IMAP_MCP_SMTP_HOST).toBe("smtp.example.com");
    expect(env.OTHER).toBeUndefined();
  });

  it("detects container mode only from the image flag", () => {
    expect(isContainerMode({ IMAP_MCP_CONTAINER: "1" })).toBe(true);
    expect(isContainerMode({})).toBe(false);
  });
});

describe("container secret stores", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "imcp-home-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("round-trips through AES-GCM and never writes plaintext", async () => {
    const file = path.join(home, "secrets.enc.json");
    const store = new EncryptedFileSecretStore(file, randomBytes(32));
    await store.set("main", "oauthRefreshToken", "rt-123");
    expect(await store.get("main", "oauthRefreshToken")).toBe("rt-123");
    expect(fs.readFileSync(file, "utf8")).not.toContain("rt-123");
  });

  it("fails loudly with the wrong key (tampering or mix-up)", async () => {
    const file = path.join(home, "secrets.enc.json");
    await new EncryptedFileSecretStore(file, randomBytes(32)).set("main", "password", "pw");
    await expect(new EncryptedFileSecretStore(file, randomBytes(32)).get("main", "password")).rejects.toThrow();
  });

  it("prefers a rotated token from the state file over the initial env value", async () => {
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_HOME: home,
      IMAP_MCP_OAUTH_REFRESH_TOKEN_BUERO_GMX: "initial",
      IMAP_MCP_STATE_KEY: randomBytes(32).toString("base64"),
    };
    const store = createContainerSecretStore(env);
    expect(await store.get("buero-gmx", "oauthRefreshToken")).toBe("initial");
    await store.set("buero-gmx", "oauthRefreshToken", "rotated");
    expect(await createContainerSecretStore(env).get("buero-gmx", "oauthRefreshToken")).toBe("rotated");
  });

  it("reads passwords from the environment and explains how to persist without a state key", async () => {
    const store = new ContainerSecretStore(createSecretStore({ IMAP_MCP_PASSWORD_MAIN: "pw" }, { keychain: false }));
    expect(await store.get("main", "password")).toBe("pw");
    await expect(store.set("main", "oauthRefreshToken", "x")).rejects.toThrow(/IMAP_MCP_STATE_KEY/);
  });

  it("never builds a keychain-backed store in container mode", async () => {
    const store = createRuntimeSecretStore({ IMAP_MCP_CONTAINER: "1", IMAP_MCP_HOME: home, IMAP_MCP_PASSWORD_MAIN: "pw" });
    expect(store).toBeInstanceOf(ContainerSecretStore);
    expect(await store.get("main", "password")).toBe("pw");
  });

  it("rejects a state key of the wrong length", () => {
    expect(() => new EncryptedFileSecretStore(path.join(home, "x"), Buffer.alloc(16))).toThrow(/32 random bytes/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/secrets/__tests__/container.test.ts`
Expected: FAIL — `Cannot find module '../container.js'`.

- [ ] **Step 3: Implement**

```ts
// src/secrets/container.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createSecretStore, type SecretKey, type SecretStore } from "./store.js";

/** Set by the Docker image. Container mode never touches an OS keychain. */
export function isContainerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IMAP_MCP_CONTAINER === "1";
}

/**
 * Docker-secrets convention for settings outside the secret store (e.g. IMAP_MCP_STATE_KEY_FILE):
 * `IMAP_MCP_X_FILE=/run/secrets/x` becomes `IMAP_MCP_X` (one trailing newline removed).
 * An explicitly set `IMAP_MCP_X` wins. Returns the names that were filled.
 */
export function applyFileSecrets(
  env: NodeJS.ProcessEnv,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): string[] {
  const applied: string[] = [];
  for (const [name, file] of Object.entries(env)) {
    const match = /^(IMAP_MCP_[A-Z0-9_]+)_FILE$/.exec(name);
    if (!match || !file || env[match[1]]) continue;
    env[match[1]] = readFile(file).replace(/\r?\n$/, "");
    applied.push(match[1]);
  }
  return applied;
}

interface EncryptedFile {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/** AES-256-GCM encrypted JSON map on the data volume — keeps rotated OAuth refresh tokens across restarts. */
export class EncryptedFileSecretStore implements SecretStore {
  constructor(private readonly file: string, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("IMAP_MCP_STATE_KEY must be 32 random bytes, base64-encoded.");
  }

  private read(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    const doc = JSON.parse(fs.readFileSync(this.file, "utf8")) as EncryptedFile;
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(doc.iv, "base64"));
    decipher.setAuthTag(Buffer.from(doc.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(doc.data, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as Record<string, string>;
  }

  private write(values: Record<string, string>): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
    const doc: EncryptedFile = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    return this.read()[`${accountId}:${key}`] ?? null;
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    const values = this.read();
    values[`${accountId}:${key}`] = value;
    this.write(values);
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    const values = this.read();
    delete values[`${accountId}:${key}`];
    this.write(values);
  }
}

/** Newest value from the encrypted state file, else the environment (Plan 2 env store). Never a keychain. */
export class ContainerSecretStore implements SecretStore {
  constructor(private readonly envStore: SecretStore, private readonly state?: EncryptedFileSecretStore) {}

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const stored = this.state ? await this.state.get(accountId, key) : null;
    return stored ?? (await this.envStore.get(accountId, key));
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    if (!this.state) {
      throw new Error(
        "Cannot store secrets in container mode without a state key: set IMAP_MCP_STATE_KEY or IMAP_MCP_STATE_KEY_FILE (32 random bytes, base64).",
      );
    }
    await this.state.set(accountId, key, value);
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    await this.state?.delete(accountId, key);
  }
}

/** State lives in $IMAP_MCP_HOME (the /data volume in the image), default ~/.imap-mcp. */
export function createContainerSecretStore(env: NodeJS.ProcessEnv = process.env): ContainerSecretStore {
  applyFileSecrets(env);
  const home = env.IMAP_MCP_HOME ?? path.join(os.homedir(), ".imap-mcp");
  const key = env.IMAP_MCP_STATE_KEY;
  const state = key ? new EncryptedFileSecretStore(path.join(home, "secrets.enc.json"), Buffer.from(key, "base64")) : undefined;
  return new ContainerSecretStore(createSecretStore(env, { keychain: false }), state);
}

/** The store every CLI entry point uses: container → env + encrypted state file; desktop → Plan 2/4 chain (env, keychain). */
export function createRuntimeSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  return isContainerMode(env) ? createContainerSecretStore(env) : createSecretStore(env);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/secrets/__tests__/container.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Route every entry point through `createRuntimeSecretStore`**

In `src/serve.ts` replace

```ts
import { createSecretStore } from "./secrets/store.js";
```

with

```ts
import { createRuntimeSecretStore } from "./secrets/container.js";
```

and replace

```ts
  const secrets = createSecretStore();
```

with

```ts
  const secrets = createRuntimeSecretStore(process.env);
```

In `src/cli/run.ts` replace

```ts
import { createSecretStore, type SecretStore } from "../secrets/store.js";
```

with

```ts
import type { SecretStore } from "../secrets/store.js";
import { createRuntimeSecretStore } from "../secrets/container.js";
```

and, in `defaultCliDeps`, replace

```ts
    createSecrets: (e) => createSecretStore(e),
```

with

```ts
    createSecrets: (e) => createRuntimeSecretStore(e),
```

Run: `grep -rn "createSecretStore(" src --include=*.ts | grep -v "^src/secrets/" | grep -v "__tests__"`
Expected: no output (`src/cli/login.ts` only mentions it in a doc comment).

- [ ] **Step 6: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS — outside container mode `createRuntimeSecretStore` returns exactly what `createSecretStore` returned, so every Plan 2–6 test is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/secrets/container.ts src/secrets/__tests__/container.test.ts src/serve.ts src/cli/run.ts
git commit -m "feat(secrets): container secret store (env, *_FILE, encrypted state) for every entry point

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
---

### Task 10: `serve --http`, the `http` command and the container health check

**Files:**
- Create: `src/transport/http-runtime.ts`, `src/cli/http-command.ts`, `src/cli/serve-http.ts`, `src/cli/healthcheck.ts`
- Modify: `src/serve.ts` (Plan 6's `serve(args)`), `src/cli/dispatch.ts` and `src/cli/program.ts` (Plan 6's top-level dispatcher)
- Test: `src/transport/__tests__/http-runtime.test.ts`, `src/cli/__tests__/http-command.test.ts`, `src/transport/__tests__/http-tools.test.ts`, `src/cli/__tests__/serve-http.test.ts`, `src/cli/__tests__/dispatch-http.test.ts`, `src/cli/__tests__/program-http.test.ts`

**Interfaces:**
- Consumes: Tasks 1–9; `loadConfig(env, { secrets })`, `saveConfig(config, env?)` from `src/config/load.ts`, `createAppContext(config, secrets, deps?)` from `src/context.ts`, `createServer`/`LOCAL_ONLY_TOOLS` from `src/server.ts`, `AppConfig` from `src/config/schema.ts` (Plan 2); `withDetectedEndpoints(env)` (Plan 4); `setupAudit(app, env?)` (Plan 5); `serve(args)`, `Command`, `SUBCOMMANDS`, `helpText()`, `run(parsed)` (Plan 6).
- Produces: `interface HttpOverrides { host?; port? }`, `interface HttpRuntimeDeps { secrets; createAppContext(config, secrets): AppContext; createServer(app): McpServer; jwt? }`, `type HttpRuntime = { ok: false; check } | { ok: true; check; http; app; httpApp; authMode }`, `createRemoteServer(app): McpServer` (= `createServer(app, { exclude: LOCAL_ONLY_TOOLS })`), `resolveHttpConfig(config, env, flags): HttpConfig` (config < `IMAP_MCP_HTTP_HOST`/`IMAP_MCP_HTTP_PORT` < `--host`/`--port`), `buildHttpRuntime(config, http, deps): HttpRuntime`; `interface HttpCommandDeps { loadConfig(); saveConfig(config); out(line); err(line) }`, `runHttpCommand(argv, deps): Promise<number>`, `runHttpCli(argv, env?): Promise<number>`; `interface ServeHttpHandle { url; close() }`, `startServeHttp(argv, env?): Promise<ServeHttpHandle | number>` (2 = configuration refused), `runServeHttp(argv, env?): Promise<number>`. CLI: `imap-smtp-mcp serve --http [--host H] [--port P]`, `imap-smtp-mcp http token create --id <id> [--print-only] | list | revoke --id <id>`; `dist/cli/healthcheck.js` exits 0 when `GET http://127.0.0.1:$IMAP_MCP_HTTP_PORT/healthz` returns 200.
- Start-up of `serve --http` mirrors stdio mode: runtime secret store, host autodetection for env-only accounts, `setupAudit(runtime.app)` (fails closed) — then the HTTP listener.

- [ ] **Step 1: Write the failing unit tests**

```ts
// src/transport/__tests__/http-runtime.test.ts
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "../../config/schema.js";
import { HttpAuthSchema } from "../../config/http-schema.js";
import { createSecretStore } from "../../secrets/store.js";
import { buildHttpRuntime, resolveHttpConfig } from "../http-runtime.js";
import { fakeApp } from "./fake-app.js";

const accounts = [{ id: "main", email: "max@firma.example", permissions: { read: true, write: true, send: false, delete: false } }];
const asConfig = (value: Record<string, unknown>) => value as unknown as AppConfig;

function deps(created: string[]) {
  return {
    secrets: createSecretStore({}, { keychain: false }),
    createAppContext: (config: AppConfig) => {
      created.push("app");
      return Object.assign(fakeApp(["main"]), { config });
    },
    createServer: () => new McpServer({ name: "t", version: "0" }),
  };
}

describe("resolveHttpConfig", () => {
  it("applies config < env < flags", () => {
    const config = asConfig({ accounts, http: { host: "127.0.0.1", port: 9000 } });
    expect(resolveHttpConfig(config, {}, {})).toMatchObject({ host: "127.0.0.1", port: 9000 });
    expect(resolveHttpConfig(config, { IMAP_MCP_HTTP_PORT: "9100", IMAP_MCP_HTTP_HOST: "0.0.0.0" }, {})).toMatchObject({ host: "0.0.0.0", port: 9100 });
    expect(resolveHttpConfig(config, { IMAP_MCP_HTTP_PORT: "9100" }, { port: 9200 }).port).toBe(9200);
  });
});

describe("buildHttpRuntime", () => {
  it("does not create account runtimes when the deployment is invalid", () => {
    const created: string[] = [];
    const config = asConfig({ accounts });
    const runtime = buildHttpRuntime(config, resolveHttpConfig(config, {}, {}), deps(created));
    expect(runtime.ok).toBe(false);
    expect(runtime.check.errors[0]).toMatch(/httpAuth/);
    expect(created).toEqual([]);
  });

  it("builds an OAuth runtime advertising scopesSupported in the metadata", async () => {
    const created: string[] = [];
    const config = asConfig({
      accounts,
      http: { publicUrl: "http://127.0.0.1" },
      httpAuth: HttpAuthSchema.parse({
        mode: "oauth",
        issuer: "https://login.microsoftonline.com/tid/v2.0",
        audience: "cid",
        requiredScopes: ["mail.access"],
        scopesSupported: ["api://cid/mail.access", "offline_access"],
        principals: [{ match: { group: "g" }, accounts: ["main"] }],
      }),
    });
    const runtime = buildHttpRuntime(config, resolveHttpConfig(config, {}, {}), deps(created));
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    expect(created).toEqual(["app"]);
    const res = await runtime.httpApp.fetch(
      new Request("http://127.0.0.1:8787/.well-known/oauth-protected-resource", { headers: { host: "127.0.0.1:8787" } }),
      "127.0.0.1",
    );
    expect(await res.json()).toMatchObject({ scopes_supported: ["api://cid/mail.access", "offline_access"] });
    await runtime.httpApp.close();
  });
});
```

```ts
// src/cli/__tests__/http-command.test.ts
import { describe, it, expect } from "vitest";
import type { AppConfig } from "../../config/schema.js";
import { hashToken } from "../../transport/auth/bearer.js";
import { runHttpCommand, type HttpCommandDeps } from "../http-command.js";

function harness(initial: Record<string, unknown> = {}) {
  let config = {
    accounts: [{ id: "main", email: "max@firma.example", permissions: { read: true, write: true, send: false, delete: false } }],
    ...initial,
  } as unknown as AppConfig;
  const out: string[] = [];
  const err: string[] = [];
  let saves = 0;
  const deps: HttpCommandDeps = {
    loadConfig: async () => structuredClone(config),
    saveConfig: async (c) => {
      config = c;
      saves++;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err, get config() { return config; }, get saves() { return saves; } };
}

describe("http token create", () => {
  it("stores only the hash and prints the token once with a Claude Code command", async () => {
    const h = harness({ http: { publicUrl: "https://mail.example.com" } });
    expect(await runHttpCommand(["token", "create", "--id", "laptop"], h.deps)).toBe(0);
    const token = h.out.find((l) => l.trim().startsWith("imcp_"))!.trim();
    expect(h.config.httpAuth).toEqual({ mode: "bearer", tokens: [{ id: "laptop", sha256: hashToken(token) }], principals: [] });
    expect(JSON.stringify(h.config)).not.toContain(token);
    expect(h.out.join("\n")).toContain(`claude mcp add --transport http mail https://mail.example.com/mcp --header "Authorization: Bearer ${token}"`);
  });

  it("--print-only leaves a read-only config untouched and prints the entry", async () => {
    const h = harness();
    expect(await runHttpCommand(["token", "create", "--id", "routine", "--print-only"], h.deps)).toBe(0);
    expect(h.saves).toBe(0);
    expect(h.out.join("\n")).toMatch(/"id":"routine","sha256":"[0-9a-f]{64}"/);
  });

  it("rejects duplicate and invalid ids", async () => {
    const h = harness();
    await runHttpCommand(["token", "create", "--id", "laptop"], h.deps);
    expect(await runHttpCommand(["token", "create", "--id", "laptop"], h.deps)).toBe(1);
    expect(await runHttpCommand(["token", "create", "--id", "Bad Id"], h.deps)).toBe(2);
  });

  it("refuses to mix bearer tokens into an OAuth configuration", async () => {
    const h = harness({ httpAuth: { mode: "oauth" } });
    expect(await runHttpCommand(["token", "create", "--id", "x"], h.deps)).toBe(2);
    expect(h.err[0]).toMatch(/oauth/);
  });
});

describe("http token list / revoke", () => {
  it("lists ids with a hash prefix and revokes by id, keeping principals", async () => {
    const h = harness({
      httpAuth: {
        mode: "bearer",
        tokens: [{ id: "a", sha256: "1".repeat(64) }, { id: "b", sha256: "2".repeat(64) }],
        principals: [{ match: { tokenId: "b" }, accounts: ["main"] }],
      },
    });
    await runHttpCommand(["token", "list"], h.deps);
    expect(h.out).toEqual(["a  sha256:111111111111…", "b  sha256:222222222222…"]);
    expect(await runHttpCommand(["token", "revoke", "--id", "a"], h.deps)).toBe(0);
    expect(h.config.httpAuth).toEqual({ mode: "bearer", tokens: [{ id: "b", sha256: "2".repeat(64) }], principals: [{ match: { tokenId: "b" }, accounts: ["main"] }] });
    expect(await runHttpCommand(["token", "revoke", "--id", "zzz"], h.deps)).toBe(1);
  });

  it("prints usage for unknown subcommands", async () => {
    const h = harness();
    expect(await runHttpCommand(["tokens"], h.deps)).toBe(2);
    expect(h.err[0]).toMatch(/Usage/);
  });
});
```

- [ ] **Step 2: Write the failing tests with the real tools, the real start-up and the real dispatcher**

Real tools over HTTP — mailbox scoping, `sign_in` never offered, a drafts-only mailbox gets no send tools, a bulk preview in one request committed in another (Plan 3's selection store is keyed by `app.config`, which the per-request view inherits), caller in every audit event:

```ts
// src/transport/__tests__/http-tools.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { ToolCallEvent } from "../../context.js";
import { createTestApp, standardFakeImap, type TestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { createSecretStore } from "../../secrets/store.js";
import { LOCAL_ONLY_TOOLS, createServer } from "../../server.js";
import { generateBearerToken } from "../auth/bearer.js";
import { buildHttpRuntime, createRemoteServer, resolveHttpConfig } from "../http-runtime.js";
import { startHttpServer, type RunningHttpServer } from "../http-server.js";
import type { HttpApp } from "../http-app.js";

const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

describe("real tools over HTTP", () => {
  const assistant = generateBearerToken();
  const drafter = generateBearerToken();
  const events: ToolCallEvent[] = [];
  let t: TestApp;
  let httpApp: HttpApp;
  let running: RunningHttpServer;
  let client: Client;

  async function connect(token: string): Promise<Client> {
    const c = new Client({ name: "http-tools", version: "0.0.0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    return c;
  }

  beforeAll(async () => {
    const officeImap = standardFakeImap();
    officeImap.addFolder("Archive");
    t = createTestApp(
      [
        { id: "office", imap: officeImap },
        { id: "private", email: "privat@firma.example" },
        { id: "drafts", email: "assistenz@firma.example", policy: { send: { mode: "drafts-only" } } },
      ],
      {
        http: { port: 0 },
        httpAuth: {
          mode: "bearer",
          tokens: [
            { id: "assistant", sha256: assistant.sha256 },
            { id: "drafter", sha256: drafter.sha256 },
          ],
          principals: [
            { match: { tokenId: "assistant" }, accounts: ["office"] },
            { match: { tokenId: "drafter" }, accounts: ["drafts"] },
          ],
        },
      },
    );
    t.app.observers.push({ onToolCall: (e) => void events.push(e) });
    for (const subject of ["Angebot", "Newsletter 1", "Newsletter 2"]) {
      const from = subject.startsWith("Newsletter") ? "news@shop.example" : "kunde@example.com";
      t.imap("office").addMessage("INBOX", await buildRaw({ from, to: "max@firma.example", subject, text: "Text" }));
    }
    t.imap("private").addMessage("INBOX", await buildRaw({ from: "familie@example.com", to: "privat@firma.example", subject: "Privat", text: "x" }));

    const runtime = buildHttpRuntime(t.app.config, resolveHttpConfig(t.app.config, {}, {}), {
      secrets: createSecretStore({}, { keychain: false }),
      createAppContext: () => t.app,
      createServer: createRemoteServer,
    });
    if (!runtime.ok) throw new Error(runtime.check.errors.join("; "));
    httpApp = runtime.httpApp;
    running = await startHttpServer(httpApp, { host: "127.0.0.1", port: 0, requestTimeoutMs: 10_000 });
    client = await connect(assistant.token);
  });

  afterAll(async () => {
    await client?.close();
    await running?.close();
    await httpApp?.close();
  });

  it("searches the mapped mailbox", async () => {
    const result = await client.callTool({ name: "search_emails", arguments: { from: "kunde@example.com" } });
    expect(parse(result).totalMatches).toBe(1);
  });

  it("cannot reach a mailbox that is not mapped to the token", async () => {
    const result = await client.callTool({ name: "search_emails", arguments: { account: "private" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/There is no mail account/);
    expect(JSON.stringify(result.content)).not.toContain("Privat");
  });

  it("never offers local-only tools such as sign_in over HTTP", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("search_emails");
    for (const local of LOCAL_ONLY_TOOLS) expect(names).not.toContain(local);
  });

  it("still offers sign_in to local stdio clients (so the exclusion above is meaningful)", async () => {
    const server = createServer(t.app);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const local = new Client({ name: "stdio", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), local.connect(clientTransport)]);
    expect((await local.listTools()).tools.map((tool) => tool.name)).toContain("sign_in");
    await local.close();
    await server.close();
  });

  it("lists send tools only for callers whose mailbox may send (drafts-only policy hides them)", async () => {
    const officeTools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(officeTools).toEqual(expect.arrayContaining(["send_email", "send_draft"]));

    const drafterClient = await connect(drafter.token);
    const drafterTools = (await drafterClient.listTools()).tools.map((tool) => tool.name);
    expect(drafterTools).toContain("create_draft");
    expect(drafterTools).not.toContain("send_email");
    expect(drafterTools).not.toContain("send_draft");
    await drafterClient.close();
  });

  it("previews and commits a bulk change across two separate HTTP requests", async () => {
    const filter = { from: "news@shop.example" };
    const action = { type: "move", destination: "Archive" };
    const preview = parse(await client.callTool({ name: "organize_by_filter", arguments: { filter, action } }));
    expect(preview).toMatchObject({ preview: true, count: 2 });
    expect(t.imap("office").uidsIn("Archive")).toEqual([]);

    // a second connection = new requests, new per-request server and scoped context
    const second = await connect(assistant.token);
    const commit = parse(await second.callTool({ name: "organize_by_filter", arguments: { filter, action, confirmToken: preview.confirmToken } }));
    await second.close();
    expect(commit).toMatchObject({ success: true, count: 2 });
    expect(t.imap("office").uidsIn("Archive")).toHaveLength(2);
    expect(t.imap("office").uidsIn("INBOX")).toHaveLength(1);
  });

  it("records the caller in the audit trail", () => {
    expect(events.some((e) => e.tool === "search_emails" && e.details.principal === "token:assistant")).toBe(true);
    expect(events.some((e) => e.tool === "organize_by_filter" && e.details.principal === "token:assistant")).toBe(true);
  });
});
```

`startServeHttp` refuses without `httpAuth` and, when running, writes Plan 5 audit records that carry the caller:

```ts
// src/cli/__tests__/serve-http.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { generateBearerToken } from "../../transport/auth/bearer.js";
import { startServeHttp, type ServeHttpHandle } from "../serve-http.js";

describe("serve --http start-up", () => {
  let home: string;
  let handle: ServeHttpHandle | number | undefined;
  const token = generateBearerToken();

  function writeConfig(extra: Record<string, unknown>): NodeJS.ProcessEnv {
    const config = {
      version: 2,
      accounts: [{ id: "main", email: "max@firma.example", imap: { host: "127.0.0.1", port: 993 } }],
      audit: { path: path.join(home, "audit"), includeReads: true },
      ...extra,
    };
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
    return {
      IMAP_MCP_HOME: home,
      IMAP_MCP_CONFIG: path.join(home, "config.json"),
      IMAP_MCP_NO_AUTOCONFIG: "1",
      IMAP_MCP_PASSWORD_MAIN: "not-used",
    };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "imcp-serve-"));
  });

  afterEach(async () => {
    if (handle && typeof handle !== "number") await handle.close();
    handle = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses to start without httpAuth (exit code 2) and creates no audit trail", async () => {
    handle = await startServeHttp([], writeConfig({ http: { port: 0 } }));
    expect(handle).toBe(2);
    expect(fs.existsSync(path.join(home, "audit"))).toBe(false);
  });

  it("writes an audit record with the caller for a tool call over HTTP", async () => {
    handle = await startServeHttp(
      ["--port", "0"],
      writeConfig({ httpAuth: { mode: "bearer", tokens: [{ id: "ops", sha256: token.sha256 }] } }),
    );
    if (typeof handle === "number") throw new Error(`refused with exit code ${handle}`);

    const client = new Client({ name: "serve-http-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }),
    );
    const result = await client.callTool({ name: "list_accounts", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();

    const auditDir = path.join(home, "audit");
    const lines = fs
      .readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n"))
      .map((line) => JSON.parse(line));
    expect(lines.find((r) => r.tool === "list_accounts")?.details).toMatchObject({ principal: "token:ops", principalKind: "bearer" });
  });
});
```

```ts
// src/cli/__tests__/dispatch-http.test.ts
import { describe, it, expect } from "vitest";
import { helpText, parseCommand } from "../dispatch.js";

describe("http command and serve --http in the top-level CLI", () => {
  it("routes http with its arguments", () => {
    expect(parseCommand(["http", "token", "create", "--id", "laptop"])).toEqual({
      command: "http",
      args: ["token", "create", "--id", "laptop"],
    });
  });

  it("hands --http to serve", () => {
    expect(parseCommand(["serve", "--http", "--port", "8787"])).toEqual({ command: "serve", args: ["--http", "--port", "8787"] });
  });

  it("documents both, with descriptions aligned to the existing commands", () => {
    const lines = helpText().split("\n");
    // where Plan 6's descriptions start, e.g. "  serve          Start the MCP server …"
    const column = /^( {2}serve +)\S/.exec(lines.find((l) => /^ {2}serve +\S/.test(l))!)![1].length;
    for (const name of ["serve --http", "http token"]) {
      const line = lines.find((l) => l.startsWith(`  ${name} `));
      expect(line?.slice(2, column).trimEnd()).toBe(name);
      expect(line?.charAt(column)).toMatch(/\S/);
    }
  });
});
```

```ts
// src/cli/__tests__/program-http.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { run } from "../program.js";

function captured(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join("");
}

describe("top-level dispatcher with the http command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes http to the bearer-token CLI", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await run({ command: "http", args: ["tokens"] })).toBe(2);
    expect(captured(err)).toContain("http token create --id <name>");
  });

  it("keeps setup/doctor/accounts/audit on the admin CLI", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await run({ command: "accounts", args: ["bogus"] });
    expect(captured(out) + captured(err)).not.toContain("http token create");
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/transport/__tests__/http-runtime.test.ts src/transport/__tests__/http-tools.test.ts src/cli/__tests__/http-command.test.ts src/cli/__tests__/serve-http.test.ts src/cli/__tests__/dispatch-http.test.ts src/cli/__tests__/program-http.test.ts`
Expected: FAIL — `Cannot find module '../http-runtime.js'`, `'../http-command.js'`, `'../serve-http.js'`; `parseCommand(["http", …])` throws `Unknown command "http"`; the help text has no `serve --http` line.

- [ ] **Step 4: Implement the runtime composer**

```ts
// src/transport/http-runtime.ts
import type { McpServer } from "@modelcontextprotocol/server";
import { LOCAL_ONLY_TOOLS, createServer } from "../server.js";
import type { AppConfig } from "../config/schema.js";
import type { AppContext } from "../context.js";
import type { SecretStore } from "../secrets/store.js";
import { HttpSchema, checkHttpDeployment, type DeploymentCheck, type HttpConfig } from "../config/http-schema.js";
import { createHttpAuthenticator } from "./auth/authenticator.js";
import { buildProtectedResourceMetadata } from "./auth/metadata.js";
import type { JwtVerifierDeps } from "./auth/oauth.js";
import { createHttpApp, type HttpApp } from "./http-app.js";

export interface HttpOverrides {
  host?: string;
  port?: number;
}

export interface HttpRuntimeDeps {
  secrets: SecretStore;
  createAppContext(config: AppConfig, secrets: SecretStore): AppContext;
  createServer(app: AppContext): McpServer;
  jwt?: JwtVerifierDeps;
}

export type HttpRuntime =
  | { ok: false; check: DeploymentCheck }
  | { ok: true; check: DeploymentCheck; http: HttpConfig; app: AppContext; httpApp: HttpApp; authMode: "bearer" | "oauth" };

/** The per-request server in HTTP mode: every tool except those that act on the server machine (LOCAL_ONLY_TOOLS). */
export function createRemoteServer(app: AppContext): McpServer {
  return createServer(app, { exclude: LOCAL_ONLY_TOOLS });
}

/** Effective HTTP settings: config file < IMAP_MCP_HTTP_HOST/PORT env < CLI flags. */
export function resolveHttpConfig(config: AppConfig, env: NodeJS.ProcessEnv, flags: HttpOverrides): HttpConfig {
  const base = HttpSchema.parse(config.http ?? {});
  const envPort = env.IMAP_MCP_HTTP_PORT ? Number(env.IMAP_MCP_HTTP_PORT) : undefined;
  return HttpSchema.parse({
    ...base,
    host: flags.host ?? (env.IMAP_MCP_HTTP_HOST || undefined) ?? base.host,
    port: flags.port ?? envPort ?? base.port,
  });
}

/** Validate first; only a deployable configuration creates account runtimes (IMAP connections). */
export function buildHttpRuntime(config: AppConfig, http: HttpConfig, deps: HttpRuntimeDeps): HttpRuntime {
  const check = checkHttpDeployment({ http, httpAuth: config.httpAuth, accountIds: config.accounts.map((a) => a.id) });
  if (check.errors.length > 0 || !config.httpAuth) return { ok: false, check };

  const httpAuth = config.httpAuth;
  const app = deps.createAppContext(config, deps.secrets);
  const auth = createHttpAuthenticator(httpAuth, http.publicUrl, deps.jwt);
  const metadata =
    httpAuth.mode === "oauth" && http.publicUrl
      ? buildProtectedResourceMetadata({
          publicUrl: http.publicUrl,
          issuer: httpAuth.issuer,
          scopes: httpAuth.scopesSupported ?? httpAuth.requiredScopes,
        })
      : undefined;
  const httpApp = createHttpApp({
    app,
    http,
    auth,
    principals: httpAuth.principals,
    createServer: deps.createServer,
    metadata,
  });
  return { ok: true, check, http, app, httpApp, authMode: httpAuth.mode };
}
```

- [ ] **Step 5: Implement the token command**

```ts
// src/cli/http-command.ts
import { loadConfig, saveConfig } from "../config/load.js";
import type { AppConfig } from "../config/schema.js";
import { createRuntimeSecretStore } from "../secrets/container.js";
import { generateBearerToken } from "../transport/auth/bearer.js";
import { mcpResourceUrl } from "../transport/auth/metadata.js";

export interface HttpCommandDeps {
  loadConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  "Usage:",
  "  imap-smtp-mcp http token create --id <name> [--print-only]",
  "  imap-smtp-mcp http token list",
  "  imap-smtp-mcp http token revoke --id <name>",
].join("\n");

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** `http token …` — the token is shown once; only its SHA-256 is stored in the config. */
export async function runHttpCommand(argv: string[], deps: HttpCommandDeps): Promise<number> {
  const [group, action] = argv;
  if (group !== "token" || !["create", "list", "revoke"].includes(action ?? "")) {
    deps.err(USAGE);
    return 2;
  }

  const config = await deps.loadConfig();
  const auth = config.httpAuth;
  if (auth && auth.mode !== "bearer") {
    deps.err('httpAuth.mode is "oauth" — bearer tokens are not used. Switch the mode to "bearer" first.');
    return 2;
  }
  const tokens = auth?.tokens ?? [];

  if (action === "list") {
    if (tokens.length === 0) deps.out("No bearer tokens configured.");
    for (const t of tokens) deps.out(`${t.id}  sha256:${t.sha256.slice(0, 12)}…`);
    return 0;
  }

  const id = flag(argv, "--id");
  if (!id || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
    deps.err("--id must be 1–32 characters: lowercase letters, digits and dashes.");
    return 2;
  }

  if (action === "revoke") {
    if (!tokens.some((t) => t.id === id)) {
      deps.err(`No token with id "${id}".`);
      return 1;
    }
    config.httpAuth = { mode: "bearer", tokens: tokens.filter((t) => t.id !== id), principals: auth?.principals ?? [] };
    await deps.saveConfig(config);
    deps.out(`Token "${id}" revoked. Restart the server (or wait for the config reload) for it to take effect.`);
    return 0;
  }

  if (tokens.some((t) => t.id === id)) {
    deps.err(`A token with id "${id}" already exists. Revoke it first or choose another id.`);
    return 1;
  }
  const { token, sha256 } = generateBearerToken();
  const printOnly = argv.includes("--print-only");
  if (!printOnly) {
    config.httpAuth = { mode: "bearer", tokens: [...tokens, { id, sha256 }], principals: auth?.principals ?? [] };
    await deps.saveConfig(config);
  }
  const endpoint = config.http?.publicUrl ? mcpResourceUrl(config.http.publicUrl) : "http://127.0.0.1:8787/mcp";
  deps.out(`New token "${id}" — shown only once, store it in your MCP client now:`);
  deps.out("");
  deps.out(`  ${token}`);
  deps.out("");
  if (printOnly) {
    deps.out("Add this entry to httpAuth.tokens in the config file:");
    deps.out(`  ${JSON.stringify({ id, sha256 })}`);
    deps.out("");
  }
  deps.out("Claude Code:");
  deps.out(`  claude mcp add --transport http mail ${endpoint} --header "Authorization: Bearer ${token}"`);
  return 0;
}

/** `imap-smtp-mcp http …` against the real configuration, with the same secret store as the server. */
export async function runHttpCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const secrets = createRuntimeSecretStore(env);
  return runHttpCommand(argv, {
    loadConfig: () => loadConfig(env, { secrets }),
    saveConfig: (config) => saveConfig(config, env),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
```

- [ ] **Step 6: Implement `serve --http`**

```ts
// src/cli/serve-http.ts
import { setupAudit } from "../audit/setup.js";
import { loadConfig } from "../config/load.js";
import { createAppContext } from "../context.js";
import * as log from "../logging/logger.js";
import { withDetectedEndpoints } from "../onboarding/autoconfig.js";
import { createRuntimeSecretStore } from "../secrets/container.js";
import { buildHttpRuntime, createRemoteServer, resolveHttpConfig, type HttpOverrides } from "../transport/http-runtime.js";
import { startHttpServer } from "../transport/http-server.js";

function parseFlags(argv: string[]): HttpOverrides {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const port = value("--port");
  if (port !== undefined && !/^\d{1,5}$/.test(port)) throw new Error(`--port must be a number, got "${port}".`);
  return { host: value("--host"), port: port === undefined ? undefined : Number(port) };
}

export interface ServeHttpHandle {
  /** e.g. http://127.0.0.1:8787 */
  url: string;
  close(): Promise<void>;
}

/**
 * Start `serve --http`. Returns exit code 2 when the configuration is refused (nothing started).
 * Start-up mirrors stdio mode (src/serve.ts): runtime secret store, host autodetection, audit log.
 */
export async function startServeHttp(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<ServeHttpHandle | number> {
  const secrets = createRuntimeSecretStore(env);
  // Env-only accounts only carry address and password; hosts come from autodetection (IMAP_MCP_NO_AUTOCONFIG=1 disables it).
  const configEnv = env.IMAP_MCP_NO_AUTOCONFIG === "1" ? env : await withDetectedEndpoints(env);
  const config = await loadConfig(configEnv, { secrets });
  const http = resolveHttpConfig(config, env, parseFlags(argv));
  const runtime = buildHttpRuntime(config, http, { secrets, createAppContext, createServer: createRemoteServer });

  for (const warning of runtime.check.warnings) log.warn("http.config_warning", { message: warning });
  if (!runtime.ok) {
    for (const error of runtime.check.errors) process.stderr.write(`Error: ${error}\n`);
    return 2;
  }
  setupAudit(runtime.app, env); // fails closed, like stdio mode: no audit trail, no server

  const server = await startHttpServer(runtime.httpApp, { host: http.host, port: http.port, requestTimeoutMs: http.requestTimeoutMs });
  log.info("server.running", { transport: "http", url: server.url, publicUrl: http.publicUrl, auth: runtime.authMode });
  return {
    url: server.url,
    async close() {
      await server.close();
      await runtime.httpApp.close();
      await runtime.app.shutdown();
    },
  };
}

/** `imap-smtp-mcp serve --http`: exit code 2 = configuration refused, 0 = clean shutdown after SIGINT/SIGTERM. */
export async function runServeHttp(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  log.initLogger();
  const started = await startServeHttp(argv, env);
  if (typeof started === "number") return started;

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  log.info("server.shutting_down");
  await started.close();
  log.closeLogger();
  return 0;
}
```

- [ ] **Step 7: Implement the container health check**

```ts
// src/cli/healthcheck.ts
// Docker HEALTHCHECK helper: distroless images have no curl/wget.
const port = Number(process.env.IMAP_MCP_HTTP_PORT ?? "8787");

fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) })
  .then((res) => process.exit(res.status === 200 ? 0 : 1))
  .catch(() => process.exit(1));
```

- [ ] **Step 8: Hook `--http` into `serve(args)`**

In `src/serve.ts` replace

```ts
export async function serve(_args: string[] = []): Promise<void> {
```

with

```ts
export async function serve(args: string[] = []): Promise<void> {
  if (args.includes("--http")) {
    // Remote mode (Plan 7): Streamable HTTP with mandatory authentication. Loaded lazily.
    const { runServeHttp } = await import("./cli/serve-http.js");
    const code = await runServeHttp(args);
    if (code !== 0) process.exitCode = code;
    return;
  }
```

(`program.ts` already passes `serve`'s arguments through `applyBundleArgs`, which keeps `--http`, `--host` and `--port`; it never forces an exit code for `serve`, so the refusal code 2 set here is the process exit code.)

- [ ] **Step 9: Add the `http` command to the dispatcher**

In `src/cli/dispatch.ts` replace

```ts
export type Command = "serve" | "setup" | "doctor" | "accounts" | "audit" | "help" | "version";
```

with

```ts
export type Command = "serve" | "setup" | "doctor" | "accounts" | "audit" | "http" | "help" | "version";
```

replace

```ts
export const SUBCOMMANDS: ReadonlySet<Command> = new Set<Command>(["serve", "setup", "doctor", "accounts", "audit"]);
```

with

```ts
export const SUBCOMMANDS: ReadonlySet<Command> = new Set<Command>(["serve", "setup", "doctor", "accounts", "audit", "http"]);
```

and in `helpText()` replace

```ts
    "  audit verify   Check that the audit log has not been altered",
```

with

```ts
    "  audit verify   Check that the audit log has not been altered",
    "  serve --http   Run as a remote MCP server over HTTPS (needs httpAuth; see docs/deploy/http.md)",
    "  http token     create | list | revoke bearer tokens for serve --http (only hashes are stored)",
```

In `src/cli/program.ts` (`run()`), the admin commands share one `case` block through fall-through, so the new case goes **before** that group. Replace

```ts
    case "setup":
    case "doctor":
```

with

```ts
    case "http": {
      // Bearer tokens for `serve --http`; same configuration and secret store as the server.
      const { runHttpCli } = await import("./http-command.js");
      return runHttpCli(parsed.args);
    }
    case "setup":
    case "doctor":
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run src/transport src/cli && npm run typecheck && npm run build`
Expected: PASS — http-runtime 3, http-command 6, http-tools 7, serve-http 2, dispatch-http 3, program-http 2, plus Plan 6's dispatch tests and the earlier transport tests; build succeeds.

- [ ] **Step 11: Smoke-test the built CLI**

Run (Git Bash):
```bash
export IMAP_MCP_HOME="$(mktemp -d)" IMAP_MCP_NO_AUTOCONFIG=1 IMAP_MCP_EMAIL=smoke@example.com IMAP_MCP_IMAP_HOST=imap.example.com
node dist/bin.js serve --http; echo "exit=$?"
```
Expected: `Error: HTTP mode requires "httpAuth" (bearer tokens or OAuth). Run \`imap-smtp-mcp http token create --id <name>\`.` and `exit=2`.

Run:
```bash
node dist/bin.js http token create --id smoke --print-only > "$IMAP_MCP_HOME/token.txt" && head -3 "$IMAP_MCP_HOME/token.txt"
node dist/bin.js help | grep "serve --http\|http token"
unset IMAP_MCP_HOME IMAP_MCP_NO_AUTOCONFIG IMAP_MCP_EMAIL IMAP_MCP_IMAP_HOST
```
Expected: `New token "smoke" — shown only once, store it in your MCP client now:`, an empty line, a line starting with `  imcp_`; then the two help lines from Step 9. (The output goes through a file because `| head -3` closes the pipe while the command is still writing, which makes Node report `EPIPE`.)

- [ ] **Step 12: Commit**

```bash
git add src/transport/http-runtime.ts src/cli/http-command.ts src/cli/serve-http.ts src/cli/healthcheck.ts src/serve.ts src/cli/dispatch.ts src/cli/program.ts src/transport/__tests__/http-runtime.test.ts src/transport/__tests__/http-tools.test.ts src/cli/__tests__/http-command.test.ts src/cli/__tests__/serve-http.test.ts src/cli/__tests__/dispatch-http.test.ts src/cli/__tests__/program-http.test.ts
git commit -m "feat(http): serve --http and the http token command in the CLI, container health check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docker image and compose deployment

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/config.example.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `dist/bin.js` (Plan 6's entry point: `serve --http`, `http token …`, `accounts login …`), `dist/cli/healthcheck.js`, env names from Global Constraints.
- Produces: image `imap-smtp-mcp:<version>` running as uid 65532 on a read-only root filesystem with state on volume `/data`; compose stack `mcp` + `caddy` (TLS on 443, automatic certificates).

- [ ] **Step 1: Write `.dockerignore`**

```gitignore
.git
.github
.plancheck
node_modules
dist
coverage
docs
deploy
test
*.log
*.mcpb
```

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && mkdir -p /data

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production \
    IMAP_MCP_CONTAINER=1 \
    IMAP_MCP_HOME=/data \
    IMAP_MCP_HTTP_HOST=0.0.0.0 \
    IMAP_MCP_HTTP_PORT=8787
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/cli/healthcheck.js"]
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/bin.js"]
CMD ["serve", "--http"]
```

- [ ] **Step 3: Write the example configuration**

```json
{
  "version": 2,
  "defaultAccount": "office",
  "accounts": [
    {
      "id": "office",
      "label": "Büro",
      "email": "office@example.com",
      "imap": { "host": "imap.example.com", "port": 993 },
      "smtp": { "host": "smtp.example.com", "port": 465 },
      "auth": { "type": "password" },
      "identities": [{ "email": "office@example.com", "name": "Example GmbH" }],
      "permissions": { "read": true, "write": true, "send": false, "delete": false },
      "locale": "de"
    },
    {
      "id": "office-readonly",
      "label": "Büro (nur lesen, für Automatisierungen)",
      "email": "office@example.com",
      "imap": { "host": "imap.example.com", "port": 993 },
      "auth": { "type": "password" },
      "permissions": { "read": true, "write": false, "send": false, "delete": false }
    }
  ],
  "http": {
    "host": "0.0.0.0",
    "port": 8787,
    "publicUrl": "https://mail.example.com",
    "trustProxy": 1,
    "ipAllowlist": []
  },
  "httpAuth": {
    "mode": "bearer",
    "tokens": [],
    "principals": [
      { "match": { "tokenId": "laptop" }, "accounts": ["office"] },
      { "match": { "tokenId": "morning-routine" }, "accounts": ["office-readonly"] }
    ]
  }
}
```

- [ ] **Step 4: Write the Caddyfile**

```caddyfile
# Replace mail.example.com with your DNS name (must point at this host; ports 80 and 443 open).
mail.example.com {
	# Optional network allowlist in front of the app (Anthropic egress + your office):
	# @blocked not remote_ip 160.79.104.0/21 203.0.113.0/24
	# respond @blocked 403

	reverse_proxy mcp:8787 {
		# Stream MCP responses (SSE) without buffering
		flush_interval -1
	}
	header {
		-Server
		Strict-Transport-Security "max-age=31536000"
	}
	log {
		output stderr
		format json
	}
}
```

- [ ] **Step 5: Write `deploy/docker-compose.yml`**

```yaml
# Remote imap-smtp-mcp behind Caddy (TLS). See docs/deploy/http.md.
services:
  mcp:
    build:
      context: ..
      dockerfile: Dockerfile
    image: imap-smtp-mcp:1.1.0
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    environment:
      IMAP_MCP_CONFIG: /config/config.json
      IMAP_MCP_PASSWORD_OFFICE_FILE: /run/secrets/office_password
      IMAP_MCP_PASSWORD_OFFICE_READONLY_FILE: /run/secrets/office_password
      IMAP_MCP_STATE_KEY_FILE: /run/secrets/state_key
    secrets:
      - office_password
      - state_key
    volumes:
      - ./config:/config:ro
      - mcp-data:/data
    expose:
      - "8787"
    networks: [internal]

  caddy:
    image: caddy:2.10-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      mcp:
        condition: service_healthy
    networks: [internal]

secrets:
  office_password:
    file: ./secrets/office_password.txt
  state_key:
    file: ./secrets/state_key.txt

volumes:
  mcp-data: {}
  caddy-data: {}
  caddy-config: {}

networks:
  internal: {}
```

- [ ] **Step 6: Keep deployment secrets out of git**

Append to `.gitignore`:

```gitignore
# Remote deployment secrets and local config
deploy/secrets/
deploy/config/
```

- [ ] **Step 7: Build and verify the image**

Run:
```bash
docker build -t imap-smtp-mcp:dev .
docker run --rm --read-only -e IMAP_MCP_NO_AUTOCONFIG=1 -e IMAP_MCP_EMAIL=smoke@example.com -e IMAP_MCP_IMAP_HOST=imap.example.com imap-smtp-mcp:dev; echo "exit=$?"
```
Expected: `Error: HTTP mode requires "httpAuth" …` and `exit=2` (the container refuses to run unauthenticated).

Run:
```bash
docker run --rm --entrypoint /nodejs/bin/node imap-smtp-mcp:dev -e "console.log(process.getuid(), process.version)"
```
Expected: `65532 v22.…`.

Run:
```bash
mkdir -p /tmp/imcp-smoke && cat > /tmp/imcp-smoke/config.json <<'EOF'
{ "version": 2, "accounts": [ { "id": "main", "email": "smoke@example.com", "imap": { "host": "imap.example.com", "port": 993 } } ],
  "http": { "host": "0.0.0.0", "allowedHosts": ["localhost"] },
  "httpAuth": { "mode": "bearer", "tokens": [ { "id": "smoke", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" } ] } }
EOF
docker run -d --name imcp-smoke --read-only --tmpfs /tmp -p 127.0.0.1:8787:8787 -v /tmp/imcp-smoke:/config:ro -e IMAP_MCP_CONFIG=/config/config.json -e IMAP_MCP_NO_AUTOCONFIG=1 imap-smtp-mcp:dev
sleep 20; curl -s http://localhost:8787/healthz; echo; docker inspect --format '{{.State.Health.Status}}' imcp-smoke
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/mcp -H "Content-Type: application/json" -d '{}'
docker rm -f imcp-smoke
```
Expected: `{"status":"ok"}`, `healthy`, `401`.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore deploy/docker-compose.yml deploy/Caddyfile deploy/config.example.json .gitignore
git commit -m "build(docker): distroless non-root image and Caddy compose stack for HTTP mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Deployment guide

**Files:**
- Create: `docs/deploy/http.md`

**Interfaces:**
- Consumes: CLI and config from Tasks 2–11.
- Produces: the operator guide linked from README and the security pack.

- [ ] **Step 1: Write `docs/deploy/http.md`**

````markdown
# Remote mode: imap-smtp-mcp over HTTPS

> **Kurzfassung (Deutsch):** Der Remote-Modus macht Ihre Postfächer für claude.ai (Web/App), Claude Code und geplante Automatisierungen erreichbar, auch wenn Ihr PC aus ist. Er läuft als Docker-Container hinter Caddy (automatisches HTTPS). Zugriff gibt es nur mit einem Token oder mit einer Anmeldung über Ihr eigenes Microsoft-/Keycloak-Konto; jede Person bzw. jedes Token sieht nur die Postfächer, die Sie zuweisen. Für Claude Desktop und Claude Code auf Ihrem eigenen Rechner brauchen Sie den Remote-Modus **nicht**.

## When to use it

| You want | Use |
|---|---|
| Claude Desktop or Claude Code on your own computer | Local mode (MCPB bundle or `npx imap-smtp-mcp`), not this guide |
| claude.ai in the browser or the Claude mobile app | Remote mode with OAuth (section 4) |
| Colleagues sharing one server, each seeing only their mailbox | Remote mode with OAuth + `principals` |
| Scheduled runs (Claude Code routines, Agent SDK jobs) while your PC is off | Remote mode with bearer tokens (section 3) |

## 1. Architecture

```
Claude (claude.ai / Claude Code / Agent SDK)
        │ HTTPS  (Authorization: Bearer …)
        ▼
Caddy :443  ── TLS certificates (Let's Encrypt), X-Forwarded-For
        │ http, internal Docker network
        ▼
imap-smtp-mcp :8787  (read-only container, uid 65532)
  Host/Origin check → IP allowlist → token check → mailbox mapping → rate limit → MCP tools
        │ IMAPS / SMTPS
        ▼
Your mail servers
```

The server keeps no email content. `/data` holds the audit log and, if you use OAuth for mailboxes, the encrypted refresh tokens.

## 2. Prepare the host

1. A small Linux VM (1 vCPU, 1 GB RAM) with Docker Engine 24+ and the compose plugin.
2. A DNS name such as `mail.example.com` pointing at the VM; inbound TCP 80 and 443 open (Caddy needs 80 for the certificate challenge); outbound IMAP/SMTP ports open.
3. Copy the repository (or only `Dockerfile`, `package*.json`, `tsconfig.json`, `src/`, `deploy/`) to the VM.
4. Create the configuration and secrets:

```bash
cd deploy
mkdir -p config secrets
cp config.example.json config/config.json        # then edit: accounts, publicUrl, principals
printf '%s' 'the-mailbox-password' > secrets/office_password.txt
openssl rand -base64 32 > secrets/state_key.txt
chmod 600 secrets/*
```

5. Replace `mail.example.com` in `Caddyfile` and in `config/config.json` (`http.publicUrl`).

Secrets are passed as Docker secrets (`*_FILE` variables), never baked into the image or the config file. Password variable names follow the account id: account `office-readonly` → `IMAP_MCP_PASSWORD_OFFICE_READONLY_FILE`.

The image's entry point is `node dist/bin.js`, so `docker compose run --rm mcp <command> …` runs exactly `imap-smtp-mcp <command> …` inside the container, with the container's secret store (environment, Docker secrets and the encrypted state file — never an OS keychain).

### 2.1 Attachment folders (optional)

`files.attachmentDirs` (folders whose files Claude may attach to drafts) and `files.downloadDir` (where `save_attachment` stores attachments) are paths **inside the container**. Mount the host folders and use the container paths in the configuration — the root filesystem is read-only, so only mounted folders can be written:

```yaml
    volumes:
      - ./config:/config:ro
      - mcp-data:/data
      - /srv/firma/angebote:/files/angebote:ro
      - /srv/firma/eingang:/files/eingang
```

```json
"files": { "attachmentDirs": ["/files/angebote"], "downloadDir": "/files/eingang" }
```

`save_attachment` stays available in remote mode (write tier): it writes into the mounted download folder **on the server**, not onto the caller's computer, with the same sandbox rules as locally (no path traversal, blocked executable and macro types, no overwriting). The container runs as uid 65532, so give that user write access: `sudo chown 65532:65532 /srv/firma/eingang`. In env-only mode use `IMAP_MCP_ATTACHMENT_DIRS` and `IMAP_MCP_DOWNLOAD_DIR`.

## 3. Bearer tokens (Claude Code, Agent SDK, routines)

Create one token per client so you can revoke them separately. The config file is mounted read-only, so print the entry and paste it:

```bash
docker compose run --rm mcp http token create --id laptop --print-only
```

The output shows the token **once** (`imcp_…`) and a JSON entry `{"id":"laptop","sha256":"…"}`. Add the entry to `httpAuth.tokens` in `config/config.json`, map it to mailboxes in `httpAuth.principals`, then start the stack:

```bash
docker compose up -d --build
docker compose ps        # mcp: healthy, caddy: running
curl -s https://mail.example.com/healthz   # {"status":"ok"}
```

**Claude Code:**

```bash
claude mcp add --transport http mail https://mail.example.com/mcp --header "Authorization: Bearer imcp_…"
```

**Claude Agent SDK (TypeScript):**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Summarise today's unread mail in the office mailbox.",
  options: {
    mcpServers: {
      mail: {
        type: "http",
        url: "https://mail.example.com/mcp",
        headers: { Authorization: `Bearer ${process.env.MAIL_MCP_TOKEN}` },
      },
    },
    allowedTools: ["mcp__mail__search_emails", "mcp__mail__read_email"],
  },
})) {
  if (message.type === "result" && message.subtype === "success") console.log(message.result);
}
```

**Scheduled runs:** give each automation its own token and map it to an account entry with reduced permissions — `config.example.json` contains `office-readonly`, the same mailbox with only the `read` tier. A routine that only summarises can then never move, send or delete.

Store tokens like passwords (password manager, CI secret store). Rotate: `http token create` a new one, update the client, then `http token revoke --id <old>` — for a read-only config remove the entry by hand — and `docker compose restart mcp`.

## 4. OAuth with Microsoft Entra ID (claude.ai custom connector)

claude.ai connects with OAuth 2.1 + PKCE. The server is an OAuth *resource server*: Entra ID signs people in, the server checks the access token and maps the person to mailboxes. Entra ID does not support dynamic client registration, so you register one app and enter its client id/secret in claude.ai.

### 4.1 App registration

In the Entra admin center → **App registrations → New registration**:

1. Name `imap-smtp-mcp`, *Accounts in this organizational directory only*.
2. **Expose an API → Application ID URI**: set it to exactly your MCP URL, `https://mail.example.com/mcp`. Claude sends this URL as the RFC 8707 `resource` parameter; Entra rejects the sign-in (`AADSTS9010010`) when the resource and the scope's Application ID URI differ. Entra only accepts `https://` Application ID URIs on a domain verified in your tenant (**Custom domain names**).
3. **Expose an API → Add a scope**: name `mail.access`, *Admins and users*, display name "Use mailboxes through imap-smtp-mcp".
4. **Manifest**: set `"requestedAccessTokenVersion": 2` (under `api`). Tokens then have issuer `https://login.microsoftonline.com/<tenant-id>/v2.0` and `aud` = the application (client) id.
5. **Authentication → Add a platform → Web**, redirect URI `https://claude.ai/api/mcp/auth_callback`.
6. **Certificates & secrets → New client secret** (6–12 months; put the expiry in your calendar).
7. **Token configuration → Add groups claim** (Security groups, "Group ID") and optional claim `email`, if you map by group or email.
8. **Enterprise applications → imap-smtp-mcp → Properties → Assignment required: Yes**, then assign the users/groups who may use it. Add a Conditional Access policy (MFA) for the app.

### 4.2 Server configuration

```json
"http": { "host": "0.0.0.0", "port": 8787, "publicUrl": "https://mail.example.com", "trustProxy": 1, "ipAllowlist": ["160.79.104.0/21"] },
"httpAuth": {
  "mode": "oauth",
  "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
  "audience": ["<application-client-id>", "https://mail.example.com/mcp"],
  "requiredScopes": ["mail.access"],
  "scopesSupported": ["https://mail.example.com/mcp/mail.access", "offline_access"],
  "principals": [
    { "match": { "group": "<object-id-of-group-Office>" }, "accounts": ["office"] },
    { "match": { "email": "max@example.com" }, "accounts": ["*"] }
  ]
}
```

- `requiredScopes` uses the short name Entra writes into the `scp` claim; `scopesSupported` is what clients request (full Application ID URI form) and is published at `https://mail.example.com/.well-known/oauth-protected-resource/mcp`.
- `ipAllowlist` with `160.79.104.0/21` admits only Anthropic's outbound range (claude.ai). Add your office range if colleagues also use Claude Code directly. Leave it empty if you do not want an IP restriction.
- OAuth mode requires `principals`; someone who signs in successfully but matches no rule gets HTTP 403 and sees no mailbox.

Restart: `docker compose up -d`.

### 4.3 Add the connector in claude.ai

**Settings → Connectors → Add custom connector**: name `Mail`, URL `https://mail.example.com/mcp`, **Advanced settings**: OAuth Client ID = the application id, OAuth Client Secret = the secret from 4.1 step 6 → **Add** → **Connect** → Microsoft sign-in. On Team/Enterprise plans an Owner adds the connector once for the organisation (Organization settings → Connectors).

## 5. Other identity providers

- **Keycloak / Authentik / Zitadel** (recommended broker, also for Google Workspace logins): create a confidential client for claude.ai (standard flow, PKCE S256, redirect `https://claude.ai/api/mcp/auth_callback`), add an *audience* mapper with `https://mail.example.com/mcp`, add a client scope `mail.access` that is included in the access token `scope` claim. Config: `"issuer": "https://idp.example.com/realms/kmu"`, `"audience": "https://mail.example.com/mcp"`, `"requiredScopes": ["mail.access"]`. Keycloak supports dynamic client registration, so claude.ai can also register itself if you allow it in the realm's client registration policies.
- **Google directly** is not supported: Google's access tokens for third-party APIs are opaque, not JWTs. Use Google as a login provider inside Keycloak/Authentik instead.
- The server discovers signing keys from `<issuer>/.well-known/openid-configuration` (then RFC 8414). Set `httpAuth.jwksUri` if your IdP publishes keys elsewhere.

## 6. Mailboxes that use OAuth (Microsoft 365, Google Workspace) inside the container

In local mode Claude can start a mailbox sign-in with the `sign_in` tool, which opens a browser on the computer running the server. In remote mode that computer is the server, so **`sign_in` is never offered over HTTP** — an administrator signs each OAuth mailbox in once from the command line instead, with `imap-smtp-mcp accounts login <id> --no-browser --listen-host 0.0.0.0 --port 53682` run inside the container (the image runs it as `node dist/bin.js accounts login …`):

```bash
docker compose run --rm -p 127.0.0.1:53682:53682 mcp accounts login office --no-browser --listen-host 0.0.0.0 --port 53682
```

`--no-browser` prints the sign-in URL instead of opening a browser. Open it in your browser on the machine where you ran the command; the sign-in returns to `http://localhost:53682`, which the published port forwards into the container (bound to `127.0.0.1` only, so nobody else can reach it). The command saves the refresh token and exits.

The token goes into the encrypted file `/data/secrets.enc.json` (key: `IMAP_MCP_STATE_KEY_FILE`); without a state key the command refuses to store it. Rotated refresh tokens are written back to the same file automatically. Repeat the command when a mailbox needs a new sign-in (password change, revoked consent) — Claude will report the mailbox as signed out until then.

## 7. Operations

| Task | How |
|---|---|
| Logs | `docker compose logs -f mcp` (JSON lines on stderr; no tokens, no mail content) |
| Health | `GET /healthz` → `{"status":"ok"}`; Docker health status in `docker compose ps` |
| Audit trail | `/data/audit/` in volume `mcp-data`; every call carries `principal` (`token:<id>` or `oauth:<sub>`) |
| Backup | Volume `mcp-data` (audit, encrypted tokens), `config/config.json`; keep `secrets/state_key.txt` in a separate, safe place — without it the token file cannot be decrypted |
| Upgrade | Pull/rebuild the new version, `docker compose up -d`; roll back by starting the previous image tag. Read the release notes for config changes first. |
| Revoke access | Bearer: remove the token entry, restart. OAuth: remove the user from the Entra app assignment or the mapped group. |
| Rate limits | `http.rateLimit.perMinute` / `burst` per caller (default 120/min, burst 30); `authFailuresPerMinute` per client IP (default 30) |

## 8. Security notes for remote mode

Remote mode changes the exposure: the endpoint is reachable over the network, and anyone holding a valid token, or an IdP account matched by `principals`, can use the mapped mailboxes within the permissions of those accounts.

Controls in place:

- No unauthenticated start: `serve --http` exits with code 2 without `httpAuth`, even on loopback.
- Bearer tokens: 256-bit random, only SHA-256 hashes stored, constant-time comparison, one token per client, revocable.
- OAuth: signature (JWKS), issuer, audience, expiry and scopes checked; `none`/symmetric algorithms rejected; tokens for other APIs (e.g. Microsoft Graph) rejected; unmatched users get 403.
- Per-caller mailbox scoping; other mailboxes are invisible — asking for one gets the same "There is no mail account …" answer as a non-existent account, listing only the caller's own mailboxes.
- Tools that act on the server machine (`sign_in`, which opens a browser) are never offered over HTTP; mailbox sign-in is an administrator task (section 6).
- DNS-rebinding protection (Host allowlist), browser Origin check, no CORS, optional IP allowlist, proxy-aware client IPs, body size limit (default 4 MiB), request and header timeouts, per-caller and per-IP rate limits, security headers.
- Container: distroless, non-root, read-only root filesystem, all capabilities dropped, no keychain, secrets only via Docker secrets/env and an AES-GCM state file.
- Audit trail with the caller identity for every tool call (Plan 5).

Residual risks and what to do:

- **Stolen bearer token** = access to the mapped mailboxes until revoked → one token per client, least-privilege account entries, rotate quarterly, prefer OAuth for people.
- **Compromised IdP account** → MFA/Conditional Access, assignment required, short sessions.
- **Internet exposure / DoS** → keep Caddy and the image updated, consider the IP allowlist, monitor 401/429 spikes in the logs.
- **Anthropic changes its egress range** → re-check https://claude.com/docs/connectors/custom/add-unlisted if claude.ai suddenly gets 403.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error: HTTP mode requires "httpAuth"` and exit code 2 | No `httpAuth` section | Section 3 or 4 |
| 403 `Invalid Host` | Request host is not `publicUrl`/`allowedHosts` | Set `http.publicUrl` to the name clients use |
| 403 `No mailbox is assigned to this identity` | No `principals` rule matches | Check the token id / group object id / email in the rule |
| claude.ai sign-in fails with `AADSTS9010010` | Application ID URI ≠ MCP URL | Section 4.1 step 2 |
| claude.ai loops back to sign-in | Token audience or scope rejected | `audience` must contain the application id; `requiredScopes` uses the short scope name |
| 429 with `Retry-After` | Rate limit | Raise `http.rateLimit` or slow the automation |
| 503 `temporarily_unavailable` | IdP keys not reachable | Outbound HTTPS to the IdP; set `httpAuth.jwksUri` |
````

- [ ] **Step 2: Verify the commands the guide relies on exist**

Run: `npm run build && node dist/bin.js help | grep -c "serve --http\|http token" && node dist/bin.js accounts 2>&1 | grep -c -- "--listen-host"`
Expected: `2`, then `1` (Plan 4's usage for `accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]`, printed because `accounts` without a subcommand is invalid).

- [ ] **Step 3: Commit**

```bash
git add docs/deploy/http.md
git commit -m "docs: remote HTTP deployment guide (bearer, Entra ID, Keycloak, operations, security)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Security pack, README, CLAUDE.md and the 1.1.0 changelog

**Files:**
- Create: `docs/security/remote-mode.md`
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1–12; Plan 6's `CHANGELOG.md` (`## [Unreleased]`) and release process (`docs/maintainers/releasing.md`).
- Produces: the documentation and changelog entries for release `1.1.0`; the version itself is set by Plan 6's release process, not by hand.

- [ ] **Step 1: Write `docs/security/remote-mode.md`**

```markdown
# Security assessment notes: remote (HTTP) mode

Audience: IT/security reviewers. Applies to `imap-smtp-mcp serve --http` from version 1.1.0. Local mode (stdio) is unaffected and remains the recommended default.

## Data flow

Client (claude.ai, Claude Code, Agent SDK) → HTTPS (Caddy, TLS 1.2+) → imap-smtp-mcp container → IMAPS/SMTPS → mail servers. Message content passes through memory only; it is sent to the calling client and from there to the LLM provider (Anthropic). Stored on the server: configuration (no secrets), audit log (metadata), encrypted OAuth refresh tokens for mailboxes.

## Authentication and authorisation

| Mode | Who | Mechanism |
|---|---|---|
| Bearer | Claude Code, Agent SDK, routines | 256-bit random tokens; only SHA-256 stored; constant-time check; per-token mailbox mapping; revocation by config change |
| OAuth | People via claude.ai | Organisation IdP (Entra ID / Keycloak); JWT signature via JWKS, issuer, audience, expiry, scope checks; RFC 9728 metadata; per-user/group mailbox mapping; unmatched users → 403 |

Within a mailbox, the account's permission tiers (read/write/send/delete) and the Plan 5 policy (send mode, recipient rules, rate limits, folder scope, bulk caps) apply unchanged. The caller identity is written to the audit log for every tool call.

## Network and runtime hardening

Host-header allowlist (DNS rebinding), Origin check, no CORS, optional source-IP allowlist (e.g. Anthropic `160.79.104.0/21`), proxy-aware client IP (only trusted hops), body limit, header/request timeouts, rate limits per caller and per IP for failed authentication, `Cache-Control: no-store` and restrictive security headers, HSTS. Container: distroless base, uid 65532, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, secrets via Docker secrets only, no OS keychain.

## Refusals by design

- The server does not start in HTTP mode without authentication.
- OAuth mode does not start without explicit caller → mailbox rules.
- Tokens are never logged; configuration files cannot contain plaintext tokens (schema rejects them).
- Tools that would act on the server machine (`sign_in` opens a browser) are not registered in HTTP mode; mailbox OAuth sign-in is done by an administrator with `imap-smtp-mcp accounts login <id> --no-browser`.

## Reviewer checklist

- [ ] TLS terminates at Caddy with a valid certificate; port 8787 is not published to the internet.
- [ ] `httpAuth.principals` maps every token/group to the minimum set of mailboxes.
- [ ] Automations use account entries without `send`/`delete`.
- [ ] Entra app: assignment required, Conditional Access (MFA), client secret expiry tracked.
- [ ] `ipAllowlist` decided (Anthropic range + office) or consciously left open.
- [ ] Backups of `/data` and separate storage of the state key.
- [ ] Image and Caddy update process defined (Dependabot / monthly patch window).
```

- [ ] **Step 2: Add the README section**

Append to `README.md` after the installation section:

````markdown
## Remote mode (HTTPS) — optional

Need claude.ai in the browser, colleagues sharing one server, or scheduled automations while your PC is off? Run the server remotely with Docker behind Caddy:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
claude mcp add --transport http mail https://mail.example.com/mcp --header "Authorization: Bearer imcp_…"
```

Authentication is mandatory: bearer tokens (`imap-smtp-mcp http token create --id <name>`) or your organisation's OAuth provider (Microsoft Entra ID, Keycloak). Each token or person only sees the mailboxes you assign. Full guide: [docs/deploy/http.md](docs/deploy/http.md) · Security notes: [docs/security/remote-mode.md](docs/security/remote-mode.md).
````

- [ ] **Step 3: Update `CLAUDE.md`**

Add to the **Commands** list:

```markdown
- **Remote server:** `node dist/bin.js serve --http` (refuses to start without `httpAuth`); tokens: `node dist/bin.js http token create --id <name>`
- **Docker:** `docker build -t imap-smtp-mcp:dev .`; stack in `deploy/docker-compose.yml`
```

Add a section after the security layer description:

```markdown
**Remote transport (src/transport/, Plan 7):**
- `http-app.ts` — fetch-style router: `/healthz`, RFC 9728 metadata, `/mcp` → Host/Origin checks → IP allowlist → `HttpAuthenticator` → principal → mailbox mapping → rate limit → SDK v2 `createMcpHandler` with a fresh `createRemoteServer(scopedApp)` per request (= `createServer(app, { exclude: LOCAL_ONLY_TOOLS })`, so `sign_in` is never offered remotely; add any future tool that acts on the server machine to `LOCAL_ONLY_TOOLS` in `src/server.ts`). `http-server.ts` adapts it to `node:http` via `@hono/node-server`. `http-runtime.ts` composes config, auth and app; `checkHttpDeployment` (src/config/http-schema.ts) decides whether `serve --http` may start.
- `auth/bearer.ts` (hashed tokens), `auth/oauth.ts` (jose JWT validation, JWKS discovery), `auth/metadata.ts` (protected resource metadata, WWW-Authenticate), `auth/principals.ts` (caller → mailbox rules, `scopeAppContext` adds `principal` to audit events), `auth/authenticator.ts`, `guards.ts` (client IP, CIDR, rate limiter, security headers).
- Start-up: `serve(args)` in `src/serve.ts` hands `--http` to `src/cli/serve-http.ts` (`startServeHttp`: runtime secret store, host autodetection, `setupAudit`, then the listener; `runServeHttp` waits for SIGINT/SIGTERM). The `http` command (`src/cli/dispatch.ts`, `src/cli/program.ts`) runs `runHttpCli` from `src/cli/http-command.ts`.
- `src/secrets/container.ts` — container secret store (env + `*_FILE` + AES-GCM state file, never keychain); `serve`, `serve --http`, `http` and Plan 4's admin CLI (`CliDeps.createSecrets`) all use `createRuntimeSecretStore`.
```

- [ ] **Step 4: Add the changelog entries**

In `CHANGELOG.md`, add under `## [Unreleased]` (Plan 6's release process moves them into `## [1.1.0] - <date>` and runs `npm version 1.1.0`, which also syncs the plugin manifest and tags the release — see `docs/maintainers/releasing.md`; do not bump the version by hand):

```markdown
### Added
- Remote mode: `imap-smtp-mcp serve --http` (Streamable HTTP, stateless, SDK v2) with mandatory authentication — hashed bearer tokens or OAuth access tokens from your IdP (Entra ID, Keycloak), RFC 9728 protected resource metadata, per-caller mailbox mapping (`httpAuth.principals`). Tools that act on the server machine (`sign_in`) are not offered remotely; mailboxes are signed in with `imap-smtp-mcp accounts login <id> --no-browser`.
- `imap-smtp-mcp http token create|list|revoke`.
- Hardening: Host/Origin validation, optional IP allowlist, proxy-aware client IP, rate limits, body limit, security headers; every call is audited with the caller's identity.
- Docker image (distroless, non-root, read-only) and Caddy compose stack; container secret store with Docker secrets and an encrypted state file.
- Docs: `docs/deploy/http.md`, `docs/security/remote-mode.md`.
```

- [ ] **Step 5: Full verification**

Run: `npm run build && npm run typecheck && npm test`
Expected: all green. If the GreenMail service is running: `IMAP_IT_HOST=localhost npm run test:integration` → green.

- [ ] **Step 6: Commit**

```bash
git add docs/security/remote-mode.md README.md CLAUDE.md CHANGELOG.md
git commit -m "docs: remote-mode security notes, README, CLAUDE.md and changelog for 1.1.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Contract additions (for the owners of earlier plans)

- **Plan 2:** `createServer(app)` gains an optional second argument `{ exclude?: ReadonlySet<string> }` and the export `LOCAL_ONLY_TOOLS` (Task 1); calls without options behave exactly as before. `ConfigSchema`'s inner object gains `http`/`httpAuth` (Task 2). A mailbox a caller may not use raises the existing `AccountNotFoundError`.
- **Plan 4:** no change in Plan 4's text. The tool keeps the name `sign_in` (listed in `LOCAL_ONLY_TOOLS`; any further tool that acts on the server machine must be added there). Task 9 replaces `defaultCliDeps().createSecrets` with `createRuntimeSecretStore` as Plan 4 anticipated, so `accounts login <id> --no-browser --listen-host 0.0.0.0 --port <n>` stores tokens in the container's encrypted state file.
- **Plan 5:** no change. `scopeAppContext` uses `tierAllowed` like `createAppContext`; `sanitizeDetails` keeps `principal`/`principalKind` (pinned by `audit-principal.test.ts`); `serve --http` calls `setupAudit(runtime.app)` like stdio mode.
- **Plan 6:** Task 10 extends `Command`, `SUBCOMMANDS`, `helpText()` (two lines) and `run()` (`case "http"` before the admin group) and adds the `--http` branch to `serve(args)`; the image and docs use `dist/bin.js`. Dependabot should also watch the `docker` ecosystem (`Dockerfile`, `deploy/docker-compose.yml`).
