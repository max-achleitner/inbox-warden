import { z } from "zod";
import type { ImapFlow } from "imapflow";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { listFolderInfo, pickSpecialFolder } from "../imap/folders.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { checkNotInTrash } from "../policy/trash-move.js";
import { existingUids, strictMove } from "../imap/strict.js";
import { uniqueUids } from "../imap/flags.js";
import { searchFilterShape } from "../imap/search-query.js";
import { commitBulk, previewBulk } from "../bulk/run.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "delete_email",
      title: "Delete emails",
      description:
        "Delete emails by moving them to the Trash folder. Nothing is ever deleted permanently: emails already in Trash (or a folder below it) are refused, " +
        "and emptying the Trash is done by the user in their own mail program. " +
        "Either pass uids, or pass a filter (same filters as search_emails): a filter call only previews (count, sample, confirmToken) and deletes nothing; " +
        "after the user agreed, call again with the same folder plus confirmToken to move exactly the previewed messages to Trash. " +
        'For the whole folder pass the filter {"all": true}; a filter without any criterion is refused.',
      tier: "delete",
      input: {
        folder: z.string().default("INBOX").describe("Folder containing the emails"),
        uids: z.array(z.number().int().positive()).min(1).max(500).optional().describe("Email UIDs to delete"),
        filter: z.strictObject(searchFilterShape).optional().describe("Select the emails by filter instead of UIDs (preview first)"),
        confirmToken: z.string().min(1).optional().describe("Token from a filter preview; only send it after the user agreed"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      errorPrefix: "Error deleting emails",
      meta: { "anthropic/requiresUserInteraction": true },
    },
    async ({ folder, uids, filter, confirmToken }, inv) => {
      if (uids && (filter || confirmToken)) {
        throw new Error("Pass either uids, or filter/confirmToken — not both. Nothing was deleted.");
      }
      const client = await inv.account.getClient();
      const folders = await listFolderInfo(client);
      const path = await resolvePolicyFolder(inv.account, client, folder, folders);
      const trashFolder = pickSpecialFolder(folders, "\\Trash");
      if (!trashFolder) {
        throw new Error(
          "This mail account has no Trash folder. delete_email only moves emails into the Trash and never deletes them permanently, " +
            "so it cannot delete anything here. Nothing was deleted. Move the emails to another folder such as Archive, or delete them in your own mail program.",
        );
      }
      checkNotInTrash(folders, path);

      const remove = async (c: ImapFlow, list: number[]): Promise<Record<string, unknown>> => {
        await strictMove(c, list, trashFolder);
        return { action: "moved_to_trash", from: path, trashFolder };
      };

      if (confirmToken) {
        return commitBulk(app, inv, { token: confirmToken, folder: path, action: { type: "delete" }, apply: remove });
      }
      if (filter) {
        return previewBulk(app, inv, { folder: path, filters: filter, action: { type: "delete" } });
      }
      if (!uids) {
        throw new Error("Pass uids, or a filter to preview a bulk delete. Nothing was deleted.");
      }

      const lock = await client.getMailboxLock(path);
      try {
        const requested = uniqueUids(uids);
        const present = await existingUids(client, requested);
        const missingUids = requested.filter((u) => !present.includes(u));
        if (present.length === 0) {
          throw new Error(`None of the UIDs exist in "${path}". Nothing was deleted.`);
        }
        inv.account.policy.checkBulk(present.length, "delete");
        const outcome = await remove(client, present);
        inv.record({ folder: path, uids: present, action: outcome.action, destination: trashFolder });
        return jsonResult({
          success: true,
          ...outcome,
          folder: path,
          uids: present,
          ...(missingUids.length > 0 ? { missingUids } : {}),
        });
      } finally {
        try { lock.release(); } catch { /* connection may already be dead */ }
      }
    },
  );
}
