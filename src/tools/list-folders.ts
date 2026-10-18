import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { isAggregateFolder } from "../imap/folders.js";
import { visibleFolders } from "../policy/folder-access.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "list_folders",
      title: "List folders",
      description: "List all mail folders (mailboxes) with their special use (Drafts, Sent, Trash, …)",
      tier: "read",
      input: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      errorPrefix: "Error listing folders",
    },
    async (_args, inv) => {
      const client = await inv.account.getClient();
      const tree = await client.listTree();

      const folders: Array<{
        name: string;
        path: string;
        delimiter: string;
        flags: string[];
        specialUse?: string;
        aggregate?: true;
      }> = [];

      flattenTree(tree, folders);
      return jsonResult(visibleFolders(inv.account, folders));
    },
  );
}

function flattenTree(node: any, result: any[]) {
  // Skip the synthetic root node (empty path)
  if (node.path) {
    result.push({
      name: node.name,
      path: node.path,
      delimiter: node.delimiter,
      flags: Array.from(node.flags || []),
      specialUse: node.specialUse,
      ...(isAggregateFolder(node.flags || []) ? { aggregate: true } : {}),
    });
  }

  if (node.folders) {
    for (const child of node.folders) {
      flattenTree(child, result);
    }
  }
}
