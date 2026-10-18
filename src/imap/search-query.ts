import { z } from "zod";
import type { MailboxObject, SearchObject } from "imapflow";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a valid calendar date");

/** Filter fields shared by every tool that selects messages by criteria. */
export const searchFilterShape = {
  all: z.literal(true).optional().describe("Every email in the folder; cannot be combined with other filters"),
  query: z.string().min(1).optional().describe("Text that must appear in the subject or body"),
  subject: z.string().min(1).optional().describe("Text that must appear in the subject line"),
  from: z.string().min(1).optional().describe("Sender address or name (substring match)"),
  to: z.string().min(1).optional().describe("To: recipient address or name (substring match)"),
  cc: z.string().min(1).optional().describe("Cc: recipient address or name (substring match)"),
  since: isoDate.optional().describe("Only emails received on or after this date (YYYY-MM-DD)"),
  before: isoDate.optional().describe("Only emails received before this date, exclusive (YYYY-MM-DD)"),
  unread: z.boolean().optional().describe("true = only unread, false = only read"),
  flagged: z.boolean().optional().describe("true = only flagged/starred, false = only unflagged"),
  answered: z.boolean().optional().describe("true = only replied-to, false = only unreplied"),
  keyword: z.string().min(1).optional().describe("Only emails carrying this custom keyword, e.g. $Done"),
  hasAttachment: z.boolean().optional().describe("true = only with attachments, false = only without"),
  largerThan: z.number().int().positive().optional().describe("Only emails larger than this many bytes"),
  smallerThan: z.number().int().positive().optional().describe("Only emails smaller than this many bytes"),
  header: z.record(z.string().min(1), z.string().min(1)).optional().describe('Header substring matches, e.g. {"List-Id": "newsletter"}'),
  gmailQuery: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Gmail accounts only: Gmail search syntax, e.g. "category:promotions" or "from:shop.example older_than:1y". ' +
        'Gmail matches whole words: "Gebühr" does not find "Gebührenbescheinigung", so list compound words explicitly. ' +
        'An address containing "+" can break an OR group; use the sender domain or display name there.',
    ),
};

const searchFilterSchema = z.strictObject(searchFilterShape);
export type SearchFilters = z.infer<typeof searchFilterSchema>;

export class UnsupportedFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFilterError";
  }
}

export interface CompiledSearch {
  /** Query for client.search(); `{ all: true }` only for the `all` filter or when no filter was given. */
  query: SearchObject;
  /** Filters that were actually applied — echoed back so the AI can verify its selection. */
  applied: Record<string, unknown>;
  /** IMAP has no attachment criterion; this one is evaluated client-side from BODYSTRUCTURE. */
  hasAttachment?: boolean;
}

function canUseKeyword(mailbox: MailboxObject | false, keyword: string): boolean {
  if (!mailbox) return false;
  const permanent = mailbox.permanentFlags;
  return !permanent || permanent.has("\\*") || permanent.has(keyword) || mailbox.flags.has(keyword);
}

/**
 * Translate filters into an imapflow SearchObject. Throws instead of dropping a criterion,
 * because a dropped criterion widens the match — up to the whole folder.
 */
export function compileSearch(filters: SearchFilters, mailbox: MailboxObject | false, server: { gmail?: boolean } = {}): CompiledSearch {
  if (filters.all) {
    const others = Object.keys(filters).filter((key) => key !== "all");
    if (others.length > 0) {
      throw new UnsupportedFilterError(
        `"all" selects every email in the folder and cannot be combined with ${others.map((key) => `"${key}"`).join(", ")}. Not searching.`,
      );
    }
    return { query: { all: true }, applied: { all: true } };
  }
  const query: SearchObject = {};
  const applied: Record<string, unknown> = {};

  // Gmail evaluates X-GM-RAW inside the selected mailbox and ANDs it with the other criteria:
  // "in:anywhere", "in:spam" or "label:X" never reach past the folder (checked on Gmail, 2026-10-18).
  // The folder policy holds either way, since the UIDs that come back belong to the selected mailbox.
  if (filters.gmailQuery) {
    if (!server.gmail) {
      throw new UnsupportedFilterError("gmailQuery only works with Gmail and Google Workspace accounts. Not searching.");
    }
    query.gmraw = filters.gmailQuery;
    applied.gmailQuery = filters.gmailQuery;
  }
  if (filters.query) {
    query.or = [{ subject: filters.query }, { body: filters.query }];
    applied.query = filters.query;
  }
  for (const key of ["subject", "from", "to", "cc"] as const) {
    const value = filters[key];
    if (value) {
      query[key] = value;
      applied[key] = value;
    }
  }
  if (filters.since) {
    query.since = filters.since;
    applied.since = filters.since;
  }
  if (filters.before) {
    query.before = filters.before;
    applied.before = filters.before;
  }
  if (filters.since && filters.before && filters.since >= filters.before) {
    throw new UnsupportedFilterError(`"since" (${filters.since}) must be earlier than "before" (${filters.before}).`);
  }
  if (filters.unread !== undefined) {
    query.seen = !filters.unread;
    applied.unread = filters.unread;
  }
  if (filters.flagged !== undefined) {
    query.flagged = filters.flagged;
    applied.flagged = filters.flagged;
  }
  if (filters.answered !== undefined) {
    query.answered = filters.answered;
    applied.answered = filters.answered;
  }
  if (filters.keyword) {
    if (!canUseKeyword(mailbox, filters.keyword)) {
      throw new UnsupportedFilterError(
        `This folder does not support the custom keyword "${filters.keyword}" (common on Microsoft Exchange), so no message can carry it. Not searching.`,
      );
    }
    query.keyword = filters.keyword;
    applied.keyword = filters.keyword;
  }
  if (filters.largerThan !== undefined) {
    query.larger = filters.largerThan;
    applied.largerThan = filters.largerThan;
  }
  if (filters.smallerThan !== undefined) {
    query.smaller = filters.smallerThan;
    applied.smallerThan = filters.smallerThan;
  }
  if (filters.header && Object.keys(filters.header).length > 0) {
    query.header = filters.header;
    applied.header = filters.header;
  }
  if (filters.hasAttachment !== undefined) applied.hasAttachment = filters.hasAttachment;

  if (Object.keys(query).length === 0) query.all = true;
  return { query, applied, hasAttachment: filters.hasAttachment };
}

/** True when any text filter contains non-ASCII characters (some servers reject CHARSET UTF-8). */
export function hasNonAsciiText(filters: SearchFilters): boolean {
  const texts = [filters.query, filters.subject, filters.from, filters.to, filters.cc, filters.gmailQuery, ...Object.values(filters.header ?? {})];
  return texts.some((t) => typeof t === "string" && /[^\x00-\x7F]/.test(t));
}
