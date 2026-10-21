import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SERVER_NAME, VERSION } from "./version.js";
import * as log from "./logging/logger.js";

export const SETUP_PROBLEM_TOOLS = ["health_check", "list_accounts"] as const;

const INSTRUCTIONS =
  "Inbox Warden could not start because its settings are incomplete or invalid. Call health_check, then explain the problem and the fix to the user in their language. You have no access to their email until it is fixed; never claim otherwise.";

function answer(problem: string): string {
  return (
    `Inbox Warden is not set up correctly, so no mailbox is connected: ${problem}\n` +
    "Nothing was read, changed or sent. To fix it, open the settings — Claude Desktop: Settings → Extensions → Inbox Warden → Configure; Claude Code: /plugin → Installed → Inbox Warden → Configure — correct the entry and save; then start a new chat."
  );
}

/**
 * A server without mail access that only explains what is wrong with the settings. No AppContext
 * exists here, so the two tools are registered directly with `registerTool` — the one allowed
 * exception to `defineTool`.
 */
export function createSetupProblemServer(problem: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  const tools: Record<(typeof SETUP_PROBLEM_TOOLS)[number], { title: string; description: string }> = {
    health_check: { title: "Check setup", description: "Reports why Inbox Warden is not connected to any mailbox and how to fix it." },
    list_accounts: { title: "List mailboxes", description: "No mailbox is connected: reports why and how to fix it." },
  };
  for (const name of SETUP_PROBLEM_TOOLS) {
    server.registerTool(
      name,
      {
        ...tools[name],
        inputSchema: z.strictObject({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => ({ isError: true, content: [{ type: "text" as const, text: answer(problem) }] }),
    );
  }
  return server;
}

export function serveSetupProblem(problem: string): void {
  log.info("server.setup_problem", { problem });
  serveStdio(() => createSetupProblemServer(problem));
}
