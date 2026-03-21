import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "list_folders",
    "List all mail folders (mailboxes) with message counts",
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        const client = await getClient();
        const tree = await client.listTree();

        const folders: Array<{
          name: string;
          path: string;
          delimiter: string;
          flags: string[];
          specialUse?: string;
        }> = [];

        flattenTree(tree, folders);

        return {
          content: [{ type: "text", text: JSON.stringify(folders, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error listing folders: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
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
    });
  }

  if (node.folders) {
    for (const child of node.folders) {
      flattenTree(child, result);
    }
  }
}
