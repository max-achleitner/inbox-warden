import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "delete_email",
    "Delete emails by moving them to Trash (or expunge if already in Trash)",
    {
      folder: z.string().default("INBOX").describe("Folder containing the emails"),
      uids: z.array(z.number()).min(1).describe("Email UIDs to delete"),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ folder, uids }) => {
      try {
        const client = await getClient();
        const lock = await client.getMailboxLock(folder);

        try {
          const uidStr = uids.join(",");

          // Find the Trash folder first — we need it for both checks
          let trashFolder: string | null = null;
          const tree = await client.listTree();
          const allFolders: string[] = [];
          function walkTree(node: any) {
            if (node.specialUse === "\\Trash") {
              trashFolder = node.path;
            }
            allFolders.push(node.path);
            if (node.folders) node.folders.forEach(walkTree);
          }
          walkTree(tree);

          // Fall back to case-insensitive name matching
          if (!trashFolder) {
            const trashNames = ["trash", "[gmail]/trash", "deleted items", "deleted"];
            for (const folderPath of allFolders) {
              if (trashNames.includes(folderPath.toLowerCase())) {
                trashFolder = folderPath;
                break;
              }
            }
          }

          // If we're already in the Trash folder, expunge permanently
          if (trashFolder && folder.toLowerCase() === trashFolder.toLowerCase()) {
            await client.messageDelete(uidStr, { uid: true });
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  action: "expunged",
                  uids,
                  folder,
                }, null, 2),
              }],
            };
          }

          if (!trashFolder) {
            return {
              content: [{ type: "text", text: "Error: Could not find Trash folder" }],
              isError: true,
            };
          }

          await client.messageMove(uidStr, trashFolder, { uid: true });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                action: "moved_to_trash",
                uids,
                from: folder,
                trashFolder,
              }, null, 2),
            }],
          };
        } finally {
          lock.release();
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error deleting emails: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
