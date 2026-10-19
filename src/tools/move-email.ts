import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { listFolderInfo } from "../imap/folders.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { checkTrashMove, movesIntoTrash } from "../policy/trash-move.js";
import { existingUids, strictMove } from "../imap/strict.js";
import { uniqueUids } from "../imap/flags.js";
import { defineTool } from "./shared/define-tool.js";
import { errorResult, jsonResult } from "./shared/result.js";
import { uidMappingFields } from "./shared/uid-mapping.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "move_email",
      title: "Move emails",
      description: "Move emails from one folder to another. The destination folder must already exist.",
      tier: "write",
      input: {
        folder: z.string().default("INBOX").describe("Source folder path"),
        uids: z.array(z.number().int().positive()).min(1).max(1000).describe("Email UIDs to move"),
        destination: z.string().describe("Destination folder path (e.g., Archive). Moving into Trash counts as deleting and needs the delete permission"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      errorPrefix: "Error moving emails",
    },
    async ({ folder, uids, destination }, inv) => {
      const client = await inv.account.getClient();
      const folders = await listFolderInfo(client);
      const source = await resolvePolicyFolder(inv.account, client, folder, folders);
      const target = await resolvePolicyFolder(inv.account, client, destination, folders);
      if (source === target) {
        return errorResult("Error moving emails", `Source and destination are the same folder ("${source}"). Nothing was moved.`);
      }
      const intoTrash = movesIntoTrash(folders, target);
      if (intoTrash) checkTrashMove(inv.account);

      const lock = await client.getMailboxLock(source);
      try {
        const requested = uniqueUids(uids);
        const present = await existingUids(client, requested, inv.account.policy.messageScope(folders));
        const missingUids = requested.filter((u) => !present.includes(u));
        if (present.length === 0) {
          return errorResult("Error moving emails", `None of the UIDs exist in "${source}". Nothing was moved.`);
        }

        inv.account.policy.checkBulk(present.length, intoTrash ? "delete" : "move");
        const uidMap = await strictMove(client, present, target);
        inv.record({ folder: source, destination: target, uids: present });
        return jsonResult({
          success: true,
          from: source,
          to: target,
          moved: present.length,
          uids: present,
          ...(missingUids.length > 0 ? { missingUids } : {}),
          ...uidMappingFields(uidMap, target),
        });
      } finally {
        try { lock.release(); } catch { /* connection may already be dead */ }
      }
    },
  );
}
