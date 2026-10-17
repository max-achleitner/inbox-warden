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
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="inbox-warden"');
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
