import type { AccountConfig } from "../config/schema.js";
import { pickSpecialFolder, type FolderInfo } from "../imap/folders.js";
import { PolicyDeniedError, tierAllowed } from "./engine.js";

/**
 * Moving mail into Trash (or a folder below it) deletes it: servers purge Trash after a while and
 * "empty trash" removes its subfolders too. Such a move — of messages or of a whole folder — needs
 * the delete permission like delete_email, and the stricter bulk.maxDelete cap applies.
 * Compared case-insensitively: on servers with case-insensitive names "trash/X" lands in Trash too.
 */
export function movesIntoTrash(folders: FolderInfo[], destination: string): boolean {
  return inTrash(folders, destination);
}

/** Whether `path` is the Trash folder or a folder below it (case-insensitive, see above). */
export function inTrash(folders: FolderInfo[], path: string): boolean {
  const trash = pickSpecialFolder(folders, "\\Trash");
  if (!trash) return false;
  const target = path.toLowerCase();
  if (target === trash.toLowerCase()) return true;
  const delimiter = folders.find((f) => f.path === trash)?.delimiter;
  return !!delimiter && target.startsWith((trash + delimiter).toLowerCase());
}

/**
 * Nothing is ever deleted permanently (owner decision): delete_email only moves mail into Trash.
 * Mail that is already there stays until the user empties the Trash in their own mail program.
 */
export function checkNotInTrash(folders: FolderInfo[], path: string): void {
  if (!inTrash(folders, path)) return;
  throw new PolicyDeniedError(
    `"${path}" is the Trash folder or inside it. delete_email only moves emails into the Trash and never deletes them permanently. ` +
      "To remove them for good, empty the Trash (or delete them there) in your own mail program. Nothing was deleted.",
    "delete.permanent",
  );
}

export function checkTrashMove(account: { readonly config: AccountConfig }): void {
  if (!tierAllowed(account.config, "delete")) {
    throw new PolicyDeniedError(
      `Moving emails into the Trash folder deletes them, and the mail account "${account.config.id}" does not allow delete actions. ` +
        `Nothing was moved. Move them to another folder such as Archive, or an administrator can enable the "delete" permission.`,
      "permissions.delete",
    );
  }
}
