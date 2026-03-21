import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "flag_email",
    "Add or remove IMAP flags on emails. Standard flags: \\Seen, \\Flagged, \\Answered, \\Deleted, \\Draft. Custom keywords also supported.",
    {
      folder: z.string().default("INBOX").describe("Mailbox folder path"),
      uids: z.array(z.number()).min(1).describe("Email UIDs to modify"),
      action: z.enum(["add", "remove"]).describe("Whether to add or remove the flags"),
      flags: z.array(z.string()).min(1).describe('Flags to set, e.g. ["\\\\Flagged", "$Important"]'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ folder, uids, action, flags }) => {
      try {
        const client = await getClient();
        const lock = await client.getMailboxLock(folder);

        try {
          const uidStr = uids.join(",");
          if (action === "add") {
            await client.messageFlagsAdd(uidStr, flags, { uid: true });
          } else {
            await client.messageFlagsRemove(uidStr, flags, { uid: true });
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                uids,
                action,
                flags,
              }, null, 2),
            }],
          };
        } finally {
          lock.release();
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error flagging emails: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
