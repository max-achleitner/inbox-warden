import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { listFolderInfo, serverFolderPath } from "../imap/folders.js";
import { isSystemFolder, resolvePolicyFolder } from "../policy/folder-access.js";
import { PolicyDeniedError } from "../policy/engine.js";
import { checkTrashMove, movesIntoTrash } from "../policy/trash-move.js";
import { strictStatus, withoutImplicitExpunge } from "../imap/strict.js";
import { defineTool } from "./shared/define-tool.js";
import { errorResult, jsonResult } from "./shared/result.js";

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
        return errorResult("Error deleting folder", `Folder "${resolved}" contains ${status.messages} message(s). Move or delete them first. Nothing was deleted.`);
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
      if (descendants.some((f) => !inv.account.policy.folderAllowed(f.path, f.delimiter, f.aggregate))) {
        throw new PolicyDeniedError(
          `"${resolved}" cannot be renamed or moved because of your administrator's folder policy. Nothing was renamed.`,
          "folders",
        );
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
