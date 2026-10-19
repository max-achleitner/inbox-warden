import type { ImapFlow } from "imapflow";
import { FolderNotFoundError, listFolderInfo, matchFolder, pickSpecialFolder, type FolderInfo } from "../imap/folders.js";
import { PolicyDeniedError, type PolicyEngine } from "./engine.js";

/** Anything carrying a policy engine — AccountRuntime satisfies this. */
export interface PolicyHolder {
  readonly policy: PolicyEngine;
}

/** Folders the account's policy lets the AI see. */
export function visibleFolders<T extends { path: string; delimiter?: string; aggregate?: true }>(account: PolicyHolder, folders: T[]): T[] {
  return folders.filter((f) => account.policy.folderAllowed(f.path, f.delimiter, f.aggregate));
}

/**
 * resolveFolder() with folder scope applied. A name that resolves to a hidden folder among all
 * folders is refused as a policy denial; it is never silently mapped to a visible folder with a
 * similar name. Names that are unknown, or ambiguous only because of hidden folders, are matched
 * among the visible folders, so suggestions never reveal hidden ones. Pass `folders` when the
 * caller already listed them.
 */
export async function resolvePolicyFolder(
  account: PolicyHolder,
  client: ImapFlow,
  requested: string,
  folders?: FolderInfo[],
): Promise<string> {
  const all = folders ?? (await listFolderInfo(client));
  let resolved: FolderInfo | undefined;
  try {
    const match = matchFolder(all, requested);
    resolved = all.find((f) => f.path === match);
  } catch (err) {
    if (!(err instanceof FolderNotFoundError)) throw err;
  }
  if (resolved) {
    if (!account.policy.folderAllowed(resolved.path, resolved.delimiter, resolved.aggregate)) {
      throw new PolicyDeniedError(
        `Access to the folder "${requested}" is blocked by your administrator's policy. Nothing was changed.`,
        "folders",
      );
    }
    return resolved.path;
  }
  return matchFolder(visibleFolders(account, all), requested);
}

/** INBOX or a folder the server (or our well-known-name fallback) treats as Drafts/Sent/Trash/Junk/Archive. */
export function isSystemFolder(folders: FolderInfo[], folderPath: string): boolean {
  if (folderPath.toUpperCase() === "INBOX") return true;
  const info = folders.find((f) => f.path === folderPath);
  if (info?.specialUse) return true;
  return (["\\Drafts", "\\Sent", "\\Trash", "\\Junk"] as const).some((use) => pickSpecialFolder(folders, use) === folderPath);
}
