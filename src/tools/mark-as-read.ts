import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { listFolderInfo } from "../imap/folders.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { existingUids, strictStoreFlags } from "../imap/strict.js";
import { uniqueUids } from "../imap/flags.js";
import { defineTool } from "./shared/define-tool.js";
import { errorResult, jsonResult } from "./shared/result.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "mark_as_read",
      title: "Mark as read or unread",
      description: "Mark one or more emails as read/unread by UID",
      tier: "write",
      input: {
        folder: z.string().default("INBOX").describe("Mailbox folder path"),
        uids: z.array(z.number().int().positive()).min(1).max(1000).describe("Email UIDs to mark"),
        read: z.boolean().default(true).describe("true = mark read, false = mark unread"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      errorPrefix: "Error marking emails",
    },
    async ({ folder, uids, read }, inv) => {
      const client = await inv.account.getClient();
      const folders = await listFolderInfo(client);
      const path = await resolvePolicyFolder(inv.account, client, folder, folders);
      const lock = await client.getMailboxLock(path);
      try {
        const requested = uniqueUids(uids);
        const present = await existingUids(client, requested, inv.account.policy.messageScope(folders));
        const missingUids = requested.filter((u) => !present.includes(u));
        if (present.length === 0) {
          return errorResult("Error marking emails", `None of the UIDs exist in "${path}". Nothing was changed.`);
        }

        inv.account.policy.checkBulk(present.length, "mark");
        await strictStoreFlags(client, present, ["\\Seen"], read ? "add" : "remove");
        inv.record({ folder: path, uids: present, action: read ? "mark_read" : "mark_unread" });
        return jsonResult({
          success: true,
          folder: path,
          uids: present,
          markedAs: read ? "read" : "unread",
          ...(missingUids.length > 0 ? { missingUids } : {}),
        });
      } finally {
        try { lock.release(); } catch { /* connection may already be dead */ }
      }
    },
  );
}
