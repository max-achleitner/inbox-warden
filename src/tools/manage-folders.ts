import { z } from "zod";
import type { ImapFlow } from "imapflow";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { listFolderInfo, serverFolderPath } from "../imap/folders.js";
import { isSystemFolder, resolvePolicyFolder } from "../policy/folder-access.js";
import { PolicyDeniedError } from "../policy/engine.js";
import { checkTrashMove, movesIntoTrash } from "../policy/trash-move.js";
import { labelLockApplies } from "../policy/label-lock.js";
import { LABEL_SCAN_LIMIT } from "../imap/select.js";
import { strictSearch, strictStatus, visibleUids, withoutImplicitExpunge, type MessageScope } from "../imap/strict.js";
import { defineTool } from "./shared/define-tool.js";
import { errorResult, jsonResult } from "./shared/result.js";

/**
 * Whether `path` holds a message the scope hides. Fails closed: a folder too big to check within
 * `budget` counts as holding one, and labels the server does not report raise LabelCheckError.
 */
async function holdsHiddenMessages(client: ImapFlow, path: string, scope: MessageScope, budget: { remaining: number }): Promise<boolean> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const exists = client.mailbox ? client.mailbox.exists : 0;
    if (exists === 0) return false;
    if (exists > budget.remaining) return true;
    budget.remaining -= exists;
    const all = await strictSearch(client, { all: true });
    return (await visibleUids(client, all, scope)).length < all.length;
  } finally {
    try { lock.release(); } catch { /* connection may already be dead */ }
  }
}

export function registerCreate(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "create_folder",
      title: "Create folder",
      description: "Create a new mail folder (mailbox)",
      tier: "write",
      input: {
        path: z.string().min(1).describe("Full folder path to create (e.g., 'Projects/Work')"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      errorPrefix: "Error creating folder",
    },
    async ({ path }, inv) => {
      const client = await inv.account.getClient();
      const folders = await listFolderInfo(client);
      const target = serverFolderPath(client, path);
      inv.account.policy.checkFolder(target, client.namespace?.delimiter ?? folders[0]?.delimiter);
      const result = await client.mailboxCreate(target);
      inv.record({ folder: result.path, action: "create_folder" });
      return jsonResult({ success: true, path: result.path, created: result.created });
    },
  );
}

export function registerDelete(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "delete_folder",
      title: "Delete folder",
      description: "Delete an empty mail folder. Refuses folders that still contain messages or subfolders.",
      tier: "write",
      input: {
        path: z.string().min(1).describe("Full folder path to delete"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      errorPrefix: "Error deleting folder",
    },
    async ({ path }, inv) => {
      const client = await inv.account.getClient();
      const folders = await listFolderInfo(client);
      const resolved = await resolvePolicyFolder(inv.account, client, path, folders);
      inv.account.policy.checkProtectedFolder(resolved, isSystemFolder(folders, resolved));

      // IMAP DELETE erases whatever the folder still holds: only a folder known to be empty goes
      const status = await strictStatus(client, resolved, { messages: true });
      if (status.messages === undefined) {
        return errorResult("Error deleting folder", `The mail server did not report how many messages "${resolved}" contains. Nothing was deleted.`);
      }
      if (status.messages > 0) {
        // STATUS also counts messages hidden by a Gmail label: their number is not told
        const contents = labelLockApplies(client, inv.account.policy.policy.folders)
          ? "is not empty. Move or delete its messages first"
          : `contains ${status.messages} message(s). Move or delete them first`;
        return errorResult("Error deleting folder", `Folder "${resolved}" ${contents}. Nothing was deleted.`);
      }

      const target = folders.find((f) => f.path === resolved)!;
      if (folders.some((f) => f.path.startsWith(resolved + target.delimiter))) {
        return errorResult("Error deleting folder", `Folder "${resolved}" has subfolders. Delete or move them first. Nothing was deleted.`);
      }

      await withoutImplicitExpunge(client, () => client.mailboxDelete(resolved));
      inv.record({ folder: resolved, action: "delete_folder" });
      return jsonResult({ success: true, path: resolved, deleted: true });
    },
  );
}

export function registerRename(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "rename_folder",
      title: "Rename folder",
      description: "Rename or move a mail folder (mailbox)",
      tier: "write",
      input: {
        path: z.string().min(1).describe("Current folder path"),
        newPath: z.string().min(1).describe("New folder path"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      errorPrefix: "Error renaming folder",
    },
    async ({ path, newPath }, inv) => {
      const client = await inv.account.getClient();
      const folders = await listFolderInfo(client);
      const resolved = await resolvePolicyFolder(inv.account, client, path, folders);
      inv.account.policy.checkProtectedFolder(resolved, isSystemFolder(folders, resolved));
      const delimiter = folders.find((f) => f.path === resolved)?.delimiter;
      const target = serverFolderPath(client, newPath);
      inv.account.policy.checkFolder(target, delimiter);
      // RENAME moves every subfolder too: a hidden one would land where its deny rule no longer applies
      const descendants = delimiter ? folders.filter((f) => f.path.startsWith(resolved + delimiter)) : [];
      const refusal = new PolicyDeniedError(
        `"${resolved}" cannot be renamed or moved because of this mailbox's folder locks. Nothing was renamed.`,
        "folders",
      );
      if (descendants.some((f) => !inv.account.policy.folderAllowed(f.path, f.delimiter, f.aggregate))) throw refusal;
      // On Gmail a folder is a label: RENAME renames it on every message carrying it, hidden ones too
      if (labelLockApplies(client, inv.account.policy.policy.folders)) {
        const scope = inv.account.policy.messageScope(folders);
        const budget = { remaining: LABEL_SCAN_LIMIT };
        for (const f of [folders.find((x) => x.path === resolved)!, ...descendants].filter((x) => x.selectable)) {
          if (await holdsHiddenMessages(client, f.path, scope, budget)) throw refusal;
        }
      }
      // Moving a folder below Trash deletes all of its mail, subfolders included
      if (movesIntoTrash(folders, target)) {
        checkTrashMove(inv.account);
        let messages = 0;
        for (const f of [folders.find((x) => x.path === resolved)!, ...descendants].filter((x) => x.selectable)) {
          messages += (await strictStatus(client, f.path, { messages: true })).messages ?? 0;
        }
        inv.account.policy.checkBulk(messages, "delete");
      }
      const result = await withoutImplicitExpunge(client, () => client.mailboxRename(resolved, target));
      inv.record({ folder: resolved, destination: result.newPath, action: "rename_folder" });
      return jsonResult({ success: true, oldPath: resolved, newPath: result.newPath || target });
    },
  );
}
