import type { ImapFlow } from "imapflow";
import { listFolderInfo, pickSpecialFolder, type FolderInfo, type SpecialUse } from "../imap/folders.js";
import type { LabelCheck, MessageScope } from "../imap/strict.js";
import { folderDenied, type FolderRules } from "./folder-rules.js";

/** Capability of Gmail's IMAP extensions, X-GM-LABELS among them. */
export const GMAIL_EXTENSIONS = "X-GM-EXT-1";

/** Gmail's system labels for special-use folders, lower-cased (X-GM-LABELS spells them "\\Sent", "\\Draft" …). */
const SYSTEM_LABEL_FOLDERS: Record<string, SpecialUse> = {
  "\\sent": "\\Sent",
  "\\draft": "\\Drafts",
  "\\drafts": "\\Drafts",
  "\\trash": "\\Trash",
  "\\spam": "\\Junk",
  "\\junk": "\\Junk",
};

/**
 * The labels of the aggregate folders Starred and Important. folderAllowed() hides those folders
 * as soon as the rules hide anything; their labels never hide a message.
 */
const AGGREGATE_LABELS = new Set(["\\important", "\\starred"]);

/**
 * Whether one Gmail label stands for a folder a deny pattern hides (deny only: a label that is
 * merely missing from an allow list hides nothing). A user label is the folder's path with "/"
 * between levels ("Kunden/Alpha"), exactly as LIST shows it. A system label stands for INBOX or a
 * special-use folder; one without a listed folder is checked by its bare name ("\\Foo" → "Foo"),
 * which hides rather more than less.
 */
export function labelDenied(label: string, rules: FolderRules, folders: FolderInfo[]): boolean {
  if (!label.startsWith("\\")) return folderDenied(label, "/", rules);
  const key = label.toLowerCase();
  if (AGGREGATE_LABELS.has(key)) return false;
  if (key === "\\inbox") return folderDenied("INBOX", "/", rules);
  const use = SYSTEM_LABEL_FOLDERS[key];
  const path = use ? pickSpecialFolder(folders, use) : folders.find((f) => f.specialUse?.toLowerCase() === key)?.path;
  if (!path) return folderDenied(label.slice(1), "/", rules);
  return folderDenied(path, folders.find((f) => f.path === path)?.delimiter, rules);
}

/** Whether messages of `client` can be hidden by a label: a Gmail server and deny patterns. */
export function labelLockApplies(client: ImapFlow, rules: FolderRules): boolean {
  return rules.deny.length > 0 && client.capabilities.has(GMAIL_EXTENSIONS);
}

/**
 * The Gmail label lock. On Gmail, folders are labels and one message can carry several: a message
 * labelled "_NDA_Inbox" can also sit in INBOX, in "Kunden" or, as a reply, in Sent. When a deny
 * pattern hides one of its labels, the message is hidden in every folder it shows up in — every
 * tool treats it as if it did not exist. Gmail leaves the selected folder's own label out of
 * X-GM-LABELS; that folder passed the folder rules already.
 */
export class LabelLock implements MessageScope {
  /** `folders` (as listed) map system labels to folders; listed on first use when not given. */
  constructor(private readonly rules: FolderRules, private folders?: FolderInfo[]) {}

  async labelCheck(client: ImapFlow): Promise<LabelCheck | null> {
    if (!labelLockApplies(client, this.rules)) return null;
    const folders = (this.folders ??= await listFolderInfo(client));
    const denied = new Map<string, boolean>();
    return (labels) => {
      for (const label of labels) {
        let hidden = denied.get(label);
        if (hidden === undefined) denied.set(label, (hidden = labelDenied(label, this.rules, folders)));
        if (hidden) return true;
      }
      return false;
    };
  }
}
