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

  it("does not send without a confirmation in confirm mode when the HTTP client's capabilities are unknown", async () => {
    // Stateless HTTP with a 2025-era client: the per-request server never saw initialize
    const result = await client.callTool({
      name: "send_email",
      arguments: { to: "kunde@example.com", subject: "Angebot", body: "Anbei." },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cannot tell whether your app can show a confirmation dialog.*Nothing was sent/);
    expect(t.capture("office").sent).toHaveLength(0);
  });

  it("records the caller in the audit trail", () => {
    expect(events.some((e) => e.tool === "search_emails" && e.details.principal === "token:assistant")).toBe(true);
    expect(events.some((e) => e.tool === "organize_by_filter" && e.details.principal === "token:assistant")).toBe(true);
  });
});
