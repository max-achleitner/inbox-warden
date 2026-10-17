import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server.js";
import { OUTBOUND_NOTE } from "../instructions.js";
import { createTestApp } from "./helpers/test-app.js";

async function connect() {
  const t = createTestApp();
  const server = createServer(t.app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("instructions and descriptions", () => {
  it("sends the safety and policy rules to the client", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/untrusted/i);
    expect(instructions).toContain("_injectionScan");
    expect(instructions).toContain("never work around it");
    expect(instructions).toContain("declines, nothing was sent");
    await client.close();
  });

  it("marks content-returning tools as untrusted and send tools as explicit-only", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    const description = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
    for (const name of ["read_email", "search_emails", "download_attachment", "get_thread"]) {
      expect(description(name)).toMatch(/untrusted/i);
    }
    for (const name of ["send_email", "send_draft"]) {
      expect(description(name)).toContain(OUTBOUND_NOTE.trim());
    }
    await client.close();
  });
});
