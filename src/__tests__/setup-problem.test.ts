import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSetupProblemServer, SETUP_PROBLEM_TOOLS } from "../setup-problem.js";
import { startupProblem } from "../cli/program.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function connect(problem: string) {
  const server = createSetupProblemServer(problem);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("setup-problem server", () => {
  it("offers only the two setup tools", async () => {
    const client = await connect("IMAP port must be a number.");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...SETUP_PROBLEM_TOOLS]);
    expect(names).toEqual(["health_check", "list_accounts"]);
  });

  it("answers with the problem and the fix, as an error", async () => {
    const client = await connect("IMAP port must be a number.");
    for (const name of SETUP_PROBLEM_TOOLS) {
      const res = await client.callTool({ name, arguments: {} });
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      expect(res.isError).toBe(true);
      expect(text).toContain("IMAP port must be a number.");
      expect(text).toContain("Nothing was read, changed or sent.");
      expect(text).toContain("Settings → Extensions → Inbox Warden → Configure");
    }
  });

  it("never repeats a secret", () => {
    const problem = startupProblem({ IMAP_MCP_PASSWORD: "hunter2", IMAP_MCP_EMAIL: "a@gmail.com", IMAP_MCP_IMAP_PORT: "99999" });
    expect(problem).toContain("IMAP port");
    expect(problem).not.toContain("hunter2");
  });

  it("turns an old OAuth setting into a setup problem", () => {
    const problem = startupProblem({ IMAP_MCP_EMAIL: "a@firma.at", IMAP_MCP_PASSWORD: "" });
    expect(problem).toMatch(/Enter the password/);
  });
});
