import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "mark_as_read",
    "Mark one or more emails as read/unread by UID",
    {
      folder: z.string().default("INBOX").describe("Mailbox folder path"),
      uids: z.array(z.number()).min(1).describe("Email UIDs to mark"),
      read: z.boolean().default(true).describe("true = mark read, false = mark unread"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ folder, uids, read }) => {
      try {
        const client = await getClient();
        const lock = await client.getMailboxLock(folder);

        try {
          // ImapFlow expects a SequenceString like "1,2,3" for UIDs
          const uidStr = uids.join(",");
          if (read) {
            await client.messageFlagsAdd(uidStr, ["\\Seen"], { uid: true });
          } else {
            await client.messageFlagsRemove(uidStr, ["\\Seen"], { uid: true });
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                uids,
                markedAs: read ? "read" : "unread",
              }, null, 2),
            }],
          };
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error marking emails: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
