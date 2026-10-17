import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createTestApp } from "./helpers/test-app.js";
import { createServer } from "../server.js";
import { ALL_TOOLS } from "../tools/index.js";

async function connect(app: ReturnType<typeof createTestApp>["app"]) {
  const server = createServer(app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe("createServer", () => {
  it("registers only the tools the permissions allow (default: read + write)", async () => {
    const { app } = createTestApp([{ permissions: { read: true, write: true, send: false, delete: false } }]);
    const { client, close } = await connect(app);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("search_emails");
    expect(names).toContain("create_draft");
    expect(names).toContain("list_accounts");
    expect(names).not.toContain("send_email");
    expect(names).not.toContain("delete_email");
    await close();
  });

  it("gives every tool a title and explicit read-only/destructive hints", async () => {
    const { app } = createTestApp();
    const { client, close } = await connect(app);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(ALL_TOOLS.length); // every registration adds exactly one tool
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
    }
    await close();
  });

  it("sends safety instructions that treat email content as untrusted", async () => {
    const { app } = createTestApp();
    const { client, close } = await connect(app);
    expect(client.getInstructions()).toMatch(/untrusted data/);
    await close();
  });
});
