import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SERVER_NAME, VERSION } from "./version.js";
import * as log from "./logging/logger.js";

export const SETUP_PROBLEM_TOOLS = ["health_check", "list_accounts"] as const;

const INSTRUCTIONS =
  "Inbox Warden could not start because its settings are incomplete or invalid. Call health_check, then explain the problem and the fix to the user in their language. You have no access to their email until it is fixed; never claim otherwise.";

/** Form setup (extension or plugin): the address comes from the settings form, not from a config file. */
function formSetup(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.IMAP_MCP_EMAIL) && !env.IMAP_MCP_CONFIG;
}

const OPEN_SETTINGS =
  "Claude Desktop: Settings → Extensions → Inbox Warden → Configure, save, then open a new chat. Claude Code: /plugin → Installed → Inbox Warden → Configure, save, then /mcp → select the server → Reconnect.";

function answer(problem: string, env: NodeJS.ProcessEnv): string {
  const fix =
    env.IMAP_MCP_FORM === "setup"
      ? `The email address in the settings is empty, so the mailboxes set up with the command-line version are used. If the problem names a field of the settings, correct that field. Otherwise either enter the email address and password of one mailbox in the settings, or set up your mailboxes in a terminal (needs Node.js 20.19 or newer): \`npm install -g ${SERVER_NAME}\`, then \`${SERVER_NAME} setup\` (\`${SERVER_NAME} doctor\` shows what is wrong), and leave the address empty. ${OPEN_SETTINGS}`
      : formSetup(env)
        ? `To fix it, open the settings, correct the entry and save. ${OPEN_SETTINGS}`
        : `To fix it, run \`${SERVER_NAME} setup\` in a terminal (or \`${SERVER_NAME} doctor\` to see what is wrong), then restart your MCP client or reconnect the server.`;
  return `Inbox Warden is not set up correctly, so no mailbox is connected: ${problem}
Nothing was read, changed or sent. ${fix}`;
}

/**
 * A server without mail access that only explains what is wrong with the settings. No AppContext
 * exists here, so the two tools are registered directly with `registerTool` — the one allowed
 * exception to `defineTool`.
 */
export function createSetupProblemServer(problem: string, env: NodeJS.ProcessEnv = process.env): McpServer {
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
      async () => ({ isError: true, content: [{ type: "text" as const, text: answer(problem, env) }] }),
    );
  }
  return server;
}

export function serveSetupProblem(problem: string, env: NodeJS.ProcessEnv = process.env): void {
  log.info("server.setup_problem", { problem });
  serveStdio(() => createSetupProblemServer(problem, env));
}
