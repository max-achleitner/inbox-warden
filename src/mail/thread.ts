import type { SearchObject } from "imapflow";

/** Upper bound for Message-IDs taken from a References header (long threads carry dozens). */
const MAX_REFERENCE_IDS = 20;

export interface ThreadIds {
  own?: string;
  /** Message-IDs this message replies to (References + In-Reply-To), newest last. */
  ancestors: string[];
  /** First Message-ID of the conversation as far as this message knows. */
  root?: string;
}

export function threadIds(parsed: { messageId?: string; inReplyTo?: string; references?: string | string[] }): ThreadIds {
  const refs = (Array.isArray(parsed.references) ? parsed.references : (parsed.references ?? "").split(/\s+/)).filter(Boolean);
  const ancestors = [...new Set([...refs, ...(parsed.inReplyTo ? [parsed.inReplyTo] : [])])].filter(
    (id) => id !== parsed.messageId,
  );
  return {
    own: parsed.messageId,
    ancestors: ancestors.slice(-MAX_REFERENCE_IDS),
    root: refs[0] ?? parsed.inReplyTo ?? parsed.messageId,
  };
}

/**
 * IMAP query for every message of the conversation in one folder: the ancestors by Message-ID,
 * and every message that references the root or this message. Null when the message has no IDs.
 */
export function threadQuery(ids: ThreadIds): SearchObject | null {
  const terms: SearchObject[] = [];
  for (const id of new Set([...ids.ancestors, ...(ids.own ? [ids.own] : [])])) {
    terms.push({ header: { "message-id": id } });
  }
  for (const id of new Set([ids.root, ids.own].filter((x): x is string => Boolean(x)))) {
    terms.push({ header: { references: id } });
  }
  if (ids.own) terms.push({ header: { "in-reply-to": ids.own } });
  if (terms.length === 0) return null;
  return terms.length === 1 ? terms[0] : { or: terms };
}
