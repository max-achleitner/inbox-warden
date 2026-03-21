import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "move_email",
    "Move emails from one folder to another",
    {
      folder: z.string().default("INBOX").describe("Source folder path"),
      uids: z.array(z.number()).min(1).describe("Email UIDs to move"),
      destination: z.string().describe("Destination folder path (e.g., Archive, Trash)"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ folder, uids, destination }) => {
      try {
        const client = await getClient();
        const lock = await client.getMailboxLock(folder);

        try {
          const uidStr = uids.join(",");
          await client.messageMove(uidStr, destination, { uid: true });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                uids,
                from: folder,
                to: destination,
              }, null, 2),
            }],
          };
        } finally {
          lock.release();
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error moving emails: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
