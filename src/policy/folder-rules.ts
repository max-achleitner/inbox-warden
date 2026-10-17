export interface FolderRules {
  /** When set, only folders matching one of these patterns are visible. */
  allow?: string[];
  /** Folders matching any of these patterns are never visible (deny wins over allow). */
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

export function folderAllowed(path: string, delimiter: string | undefined, rules: FolderRules): boolean {
  const canonical = canonicalFolderPath(path, delimiter);
  const matches = (patterns: string[]) => patterns.some((p) => folderPatternToRegExp(p).test(canonical));
  if (matches(rules.deny)) return false;
  if (rules.allow && rules.allow.length > 0) return matches(rules.allow);
  return true;
}
