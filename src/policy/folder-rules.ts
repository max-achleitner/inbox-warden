export interface FolderRules {
  /** When set, only folders matching one of these patterns are visible (each by itself: subfolders need "X/**"). */
  allow?: string[];
  /** Folders matching any of these patterns, and every folder below them, are never visible (deny wins over allow). */
  deny: string[];
}

/** Server path in comparison form: the server's delimiter becomes "/" ("INBOX.Kunden" → "INBOX/Kunden"). */
export function canonicalFolderPath(path: string, delimiter: string | undefined): string {
  if (!delimiter || delimiter === "/") return path;
  return path.split(delimiter).join("/");
}

const regexCache = new Map<string, RegExp>();

/**
 * Folder glob → RegExp, case-insensitive, "/" as separator.
 *   *       any characters inside one folder level
 *   **      any characters across levels
 *   ?       one character
 *   X/**    X itself and everything below it
 *   ** /X   (written without the space) X at any depth, including the top level
 */
export function folderPatternToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  let p = pattern.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  let prefix = "";
  let suffix = "";
  if (p.startsWith("**/")) {
    p = p.slice(3);
    prefix = "(?:.*/)?";
  }
  if (p.endsWith("/**")) {
    p = p.slice(0, -3);
    suffix = "(?:/.*)?";
  }
  let body = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        body += ".*";
        i++;
      } else {
        body += "[^/]*";
      }
    } else if (c === "?") {
      body += "[^/]";
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const re = new RegExp(`^${prefix}${body}${suffix}$`, "i");
  regexCache.set(pattern, re);
  return re;
}

/** Whether the rules hide any folder at all. */
export function foldersRestricted(rules: FolderRules): boolean {
  return rules.deny.length > 0 || (rules.allow?.length ?? 0) > 0;
}

/**
 * The spellings a canonical path is matched in: as it is and, below INBOX, without the leading
 * "INBOX/" — the personal namespace prefix of Dovecot, Courier and Cyrus ("INBOX.Kunden"), so a
 * rule written as "Kunden" works on every server. INBOX itself stays "INBOX".
 */
function matchForms(canonical: string): string[] {
  const below = /^inbox\/(.+)$/i.exec(canonical);
  return below ? [canonical, below[1]] : [canonical];
}

/** The path and every folder above it: "A/B/C" → "A/B/C", "A/B", "A". */
function selfAndAncestors(canonical: string): string[] {
  const levels = canonical.split("/");
  return levels.map((_, i) => levels.slice(0, levels.length - i).join("/"));
}

function anyMatch(forms: string[], patterns: string[]): boolean {
  return forms.some((form) => patterns.some((p) => folderPatternToRegExp(p).test(form)));
}

/**
 * A deny pattern written with the prefix ("INBOX/_NDA_Inbox") also hides the folder on a server
 * without it: when in doubt, hide. Not for allow, where it would widen access, and not before a
 * wildcard ("INBOX/*" would become "*", every top-level folder).
 */
function denyForms(pattern: string): string[] {
  const below = /^\/*inbox\/+([^*?/].*)$/i.exec(pattern.trim().replace(/\\/g, "/"));
  return below ? [pattern, below[1]] : [pattern];
}

/**
 * Whether a deny pattern hides the folder or one above it, ignoring allow. Also used for Gmail
 * labels, which hide a message wherever it shows up.
 */
export function folderDenied(path: string, delimiter: string | undefined, rules: FolderRules): boolean {
  const canonical = canonicalFolderPath(path, delimiter);
  return anyMatch(selfAndAncestors(canonical).flatMap(matchForms), rules.deny.flatMap(denyForms));
}

/**
 * Whether the AI may see a folder.
 *   deny   hides every folder a pattern matches and everything below it: the path and each of
 *          its ancestors are checked, so deny "X" also hides "X/Y" (and deny wins over allow).
 *   allow  (when set) shows only the folders a pattern matches itself; an allowed folder does
 *          not unlock the folders below it — write "X/**" for that.
 * Both match with and without a leading "INBOX/" (see matchForms; deny patterns see denyForms).
 * An aggregate folder (Gmail's All Mail, Starred, Important) shows the mail of hidden folders
 * too, so it is hidden as soon as the rules hide anything — whatever its own name matches.
 */
export function folderAllowed(path: string, delimiter: string | undefined, rules: FolderRules, aggregate = false): boolean {
  if (aggregate && foldersRestricted(rules)) return false;
  if (folderDenied(path, delimiter, rules)) return false;
  const canonical = canonicalFolderPath(path, delimiter);
  if (rules.allow && rules.allow.length > 0) return anyMatch(matchForms(canonical), rules.allow);
  return true;
}
