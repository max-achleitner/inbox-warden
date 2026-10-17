const SYSTEM_FLAGS: Record<string, string> = {
  seen: "\\Seen",
  answered: "\\Answered",
  flagged: "\\Flagged",
  deleted: "\\Deleted",
  draft: "\\Draft",
};

/**
 * IMAP atom: 7-bit ASCII without spaces, controls, parentheses, braces, wildcards, quotes,
 * backslashes or "]". imapflow silently drops anything else from a STORE.
 */
const KEYWORD_ATOM = /^[^\s(){%*"\\\]\x00-\x1f\x7f-￿]+$/;

/**
 * Normalise a flag supplied by the AI: "flagged", "\\flagged" and "\\Flagged" all become "\\Flagged";
 * anything else must be a valid custom keyword such as "$Done".
 */
export function normalizeFlag(input: string): string {
  const trimmed = input.trim();
  const bare = trimmed.replace(/^\\+/, "").toLowerCase();
  const system = SYSTEM_FLAGS[bare];
  if (system) return system;
  if (trimmed.startsWith("\\")) {
    throw new Error(`"${input}" is not a flag that can be set. Use \\Seen, \\Answered, \\Flagged, \\Draft or a custom keyword.`);
  }
  if (!KEYWORD_ATOM.test(trimmed)) {
    throw new Error(
      `"${input}" is not a valid keyword: use plain ASCII letters, digits and symbols (no umlauts, spaces, quotes, brackets or backslashes).`,
    );
  }
  return trimmed;
}

export function uniqueUids(uids: number[]): number[] {
  return [...new Set(uids)];
}
