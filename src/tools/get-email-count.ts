import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "get_email_count",
    "Get message counts (total and unread) for one or all folders",
    {
      folder: z.string().optional().describe("Specific folder path, or omit for all folders"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ folder }) => {
      try {
        const client = await getClient();

        if (folder) {
          const status = await client.status(folder, { messages: true, unseen: true });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                folder,
                total: status.messages ?? 0,
                unread: status.unseen ?? 0,
              }, null, 2),
            }],
          };
        }

        // All folders
        const tree = await client.listTree();
        const folders: Array<{ path: string; total: number; unread: number }> = [];

        async function walkTree(node: any) {
          if (node.path) {
            try {
              const status = await client.status(node.path, { messages: true, unseen: true });
              folders.push({
                path: node.path,
                total: status.messages ?? 0,
                unread: status.unseen ?? 0,
              });
            } catch {
              // Some virtual folders may not support STATUS
            }
          }
          if (node.folders) {
            for (const child of node.folders) {
              await walkTree(child);
            }
          }
        }

        await walkTree(tree);

        return {
          content: [{ type: "text", text: JSON.stringify(folders, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error getting email count: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
