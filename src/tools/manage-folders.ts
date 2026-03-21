import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

export function registerCreate(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "create_folder",
    "Create a new mail folder (mailbox)",
    {
      path: z.string().describe("Full folder path to create (e.g., 'Projects/Work')"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ path }) => {
      try {
        const client = await getClient();
        const result = await client.mailboxCreate(path);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              path: result.path,
              created: true,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error creating folder: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}

export function registerDelete(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "delete_folder",
    "Delete a mail folder (mailbox). Refuses to delete folders that still contain messages or subfolders.",
    {
      path: z.string().describe("Full folder path to delete"),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ path }) => {
      try {
        const client = await getClient();

        // Check for messages
        const status = await client.status(path, { messages: true });
        if (status.messages && status.messages > 0) {
          return {
            content: [{
              type: "text",
              text: `Error: Folder "${path}" contains ${status.messages} message(s). Move or delete them first.`,
            }],
            isError: true,
          };
        }

        // Check for subfolders
        const tree = await client.listTree();
        function hasSubfolders(node: any): boolean {
          if (node.path === path) {
            return !!(node.folders && node.folders.length > 0);
          }
          if (node.folders) {
            return node.folders.some(hasSubfolders);
          }
          return false;
        }
        if (hasSubfolders(tree)) {
          return {
            content: [{
              type: "text",
              text: `Error: Folder "${path}" has subfolders. Delete or move them first.`,
            }],
            isError: true,
          };
        }

        await client.mailboxDelete(path);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              path,
              deleted: true,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error deleting folder: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}

export function registerRename(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "rename_folder",
    "Rename or move a mail folder (mailbox)",
    {
      path: z.string().describe("Current folder path"),
      newPath: z.string().describe("New folder path"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ path, newPath }) => {
      try {
        const client = await getClient();
        const result = await client.mailboxRename(path, newPath);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              oldPath: path,
              newPath: result.newPath || newPath,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error renaming folder: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
