import { afterEach, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createSetupProblemServer, SETUP_PROBLEM_TOOLS } from "../setup-problem.js";
import { startupProblem } from "../cli/program.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function connect(problem: string, env: NodeJS.ProcessEnv = { IMAP_MCP_EMAIL: "a@gmail.com" }) {
  const server = createSetupProblemServer(problem, env);
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
      expect(text).toContain("/mcp");
      expect(text).toContain("Reconnect");
    }
  });

  it("points a command-line user to inbox-warden setup, not to the extension dialog", async () => {
    const client = await connect("Cannot read the configuration file.", { IMAP_MCP_CONFIG: "/x/config.json" });
    const res = await client.callTool({ name: "health_check", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("Nothing was read, changed or sent.");
    expect(text).toContain("inbox-warden setup");
    expect(text).toContain("inbox-warden doctor");
    expect(text).not.toContain("Extensions");
    expect(text).not.toContain("Configure");
    const noForm = await connect("Cannot read the configuration file.", {});
    const text2 = ((await noForm.callTool({ name: "list_accounts", arguments: {} })).content as Array<{ text: string }>)[0]!.text;
    expect(text2).toContain("inbox-warden setup");
  });

  it("offers both ways out when the form's address was left empty for the setup mailboxes", async () => {
    const client = await connect('No configuration found at C:\\Users\\max\\.imap-mcp\\config.json. Run "inbox-warden setup" to configure your mail account.', {
      IMAP_MCP_FORM: "setup",
    });
    const res = await client.callTool({ name: "health_check", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("Nothing was read, changed or sent.");
    expect(text).toContain("enter the email address and password");
    expect(text).toContain("npm install -g inbox-warden");
    expect(text).toContain("inbox-warden setup");
    expect(text).toContain("leave the address empty");
    expect(text).toContain("Settings → Extensions → Inbox Warden → Configure");
    expect(text).toContain("Reconnect");
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
