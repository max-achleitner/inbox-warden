import type { ImapFlow } from "imapflow";

export type SpecialUse = "\\Drafts" | "\\Sent" | "\\Trash" | "\\Junk";

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  selectable: boolean;
  /** Shows mail filed in other folders (listed as \All, \Flagged or \Important): Gmail's All Mail, Starred, Important. */
  aggregate?: true;
}

const AGGREGATE_FLAGS = ["\\all", "\\flagged", "\\important"];

/** Well-known names (lowercase, full path) used when the server does not advertise SPECIAL-USE. */
const FALLBACK_PATHS: Record<SpecialUse, string[]> = {
  "\\Drafts": [
    "drafts", "draft", "entwürfe", "[gmail]/drafts", "[google mail]/entwürfe", "inbox.drafts", "inbox/drafts",
  ],
  "\\Sent": [
    "sent", "sent items", "sent messages", "sent mail", "gesendet", "gesendete elemente", "gesendete objekte",
    "[gmail]/sent mail", "[google mail]/gesendet", "inbox.sent", "inbox/sent",
  ],
  "\\Trash": [
    "trash", "deleted", "deleted items", "deleted messages", "papierkorb", "gelöschte elemente", "gelöschte objekte",
    "[gmail]/trash", "[google mail]/papierkorb", "inbox.trash", "inbox/trash", "inbox.deleted", "inbox/deleted",
  ],
  "\\Junk": ["junk", "spam", "junk e-mail", "junk-e-mail", "[gmail]/spam", "inbox.junk", "inbox.spam"],
};

export class FolderNotFoundError extends Error {
  constructor(readonly requested: string, readonly suggestions: string[]) {
    super(
      `Folder "${requested}" does not exist.` +
        (suggestions.length > 0
          ? ` Did you mean: ${suggestions.map((s) => `"${s}"`).join(", ")}?`
          : " Use list_folders to see the available folders."),
    );
    this.name = "FolderNotFoundError";
  }
}

export async function listFolderInfo(client: ImapFlow): Promise<FolderInfo[]> {
  const list = await client.list();
  return list.map((f) => ({
    path: f.path,
    name: f.name,
    delimiter: f.delimiter,
    specialUse: f.specialUse,
    selectable: !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"),
    // Only what the server lists counts: a folder merely named "All Mail" holds its own mail
    ...([...f.flags].some((flag) => AGGREGATE_FLAGS.includes(flag.toLowerCase())) ? { aggregate: true as const } : {}),
  }));
}

function delimiterAgnostic(path: string): string {
  return path.toLowerCase().replace(/[./]/g, "/");
}

/** Pure matcher behind resolveFolder: exact → case-insensitive → delimiter-agnostic → unique leaf name. */
export function matchFolder(folders: FolderInfo[], requested: string): string {
  const wanted = requested.trim();
  const selectable = folders.filter((f) => f.selectable);
  if (wanted.toUpperCase() === "INBOX") {
    const inbox = selectable.find((f) => f.path.toUpperCase() === "INBOX");
    if (inbox) return inbox.path;
  }
  const exact = selectable.find((f) => f.path === wanted);
  if (exact) return exact.path;

  const lower = wanted.toLowerCase();
  const steps: Array<(f: FolderInfo) => boolean> = [
    (f) => f.path.toLowerCase() === lower,
    (f) => delimiterAgnostic(f.path) === delimiterAgnostic(wanted),
    (f) => f.name.toLowerCase() === lower,
  ];
  for (const step of steps) {
    const hits = selectable.filter(step);
    if (hits.length === 1) return hits[0].path;
  }

  const suggestions = selectable
    .filter((f) => f.path.toLowerCase().includes(lower) || lower.includes(f.name.toLowerCase()))
    .map((f) => f.path)
    .slice(0, 5);
  throw new FolderNotFoundError(requested, suggestions);
}

/**
 * The path imapflow really sends for CREATE and RENAME: like its normalizePath() it adds the personal
 * namespace prefix (e.g. "INBOX.") unless the name is INBOX or already starts with it. Policy and
 * Trash checks for a new folder name must use this path, not the tool input.
 */
export function serverFolderPath(client: ImapFlow, requested: string): string {
  if (requested.toUpperCase() === "INBOX") return "INBOX";
  const prefix = client.namespace?.prefix;
  return prefix && !requested.startsWith(prefix) ? prefix + requested : requested;
}

/** Resolve a folder name supplied by the AI to the server's exact, selectable path — or throw. */
export async function resolveFolder(client: ImapFlow, requested: string): Promise<string> {
  return matchFolder(await listFolderInfo(client), requested);
}

export function pickSpecialFolder(folders: FolderInfo[], use: SpecialUse): string | null {
  const selectable = folders.filter((f) => f.selectable);
  const flagged = selectable.find((f) => f.specialUse === use);
  if (flagged) return flagged.path;
  for (const candidate of FALLBACK_PATHS[use]) {
    const hit = selectable.find((f) => f.path.toLowerCase() === candidate);
    if (hit) return hit.path;
  }
  return null;
}

/** Pass `folders` when the caller already listed them. */
export async function findSpecialFolder(client: ImapFlow, use: SpecialUse, folders?: FolderInfo[]): Promise<string | null> {
  return pickSpecialFolder(folders ?? (await listFolderInfo(client)), use);
}

export async function requireSpecialFolder(client: ImapFlow, use: SpecialUse, folders?: FolderInfo[]): Promise<string> {
  const path = await findSpecialFolder(client, use, folders);
  if (!path) {
    throw new Error(`Could not find the ${use.slice(1)} folder on this mail server. Use list_folders to check the folder names.`);
  }
  return path;
}
