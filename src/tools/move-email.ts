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
          const result = await client.messageMove(uidStr, destination, { uid: true });

          // Build UID mapping (old → new) if server supports UIDPLUS
          const uidMapping: Record<number, number> = {};
          if (result && result.uidMap) {
            for (const [oldUid, newUid] of result.uidMap) {
              uidMapping[oldUid] = newUid;
            }
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                uids,
                from: folder,
                to: destination,
                ...(Object.keys(uidMapping).length > 0 ? { uidMapping } : {}),
              }, null, 2),
            }],
          };
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
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
