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
