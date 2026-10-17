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
