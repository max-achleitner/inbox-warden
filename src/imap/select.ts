import type { ImapFlow, MailboxObject } from "imapflow";
import { ImapOperationError, strictSearch, withoutHiddenLabels, type MessageScope } from "./strict.js";
import { countsAsAttachment } from "./attachment-rule.js";
import { compileSearch, hasNonAsciiText, type SearchFilters } from "./search-query.js";

/** Cap for the client-side attachment check (IMAP has no attachment search criterion). */
export const ATTACHMENT_SCAN_LIMIT = 5000;
/** Cap for the Gmail label check of a selection, and for counting a folder without hidden messages. */
export const LABEL_SCAN_LIMIT = 20_000;
/** For results whose selection was cut to the newest LABEL_SCAN_LIMIT matches (labelScanLimited). */
export const LABEL_SCAN_NOTE =
  `Only the newest ${LABEL_SCAN_LIMIT} matching emails were considered; older ones are left out. Narrow the filter (for example with since/before) to reach them.`;

export interface FilterSelection {
  /** Matching UIDs in the selected mailbox, ascending; never one the message scope hides. */
  uids: number[];
  applied: Record<string, unknown>;
  /** True when hasAttachment was only checked on the newest ATTACHMENT_SCAN_LIMIT matches. */
  attachmentScanLimited: boolean;
  /** True when only the newest LABEL_SCAN_LIMIT matches were checked against the label lock (the rest is left out). */
  labelScanLimited: boolean;
}

/** Whether the selected mailbox can store custom keywords such as $Done (PERMANENTFLAGS contains \*). */
export function keywordsSupported(mailbox: MailboxObject | false): boolean {
  if (!mailbox) return false;
  return !mailbox.permanentFlags || mailbox.permanentFlags.has("\\*");
}

/**
 * Check if a MIME body structure contains attachment parts: "attachment" disposition, or a leaf
 * part with a file name — Apple Mail and many mobile clients send files as "inline; filename=…".
 * Images embedded in HTML by Content-ID (logos in signatures) do not count.
 */
export function hasAttachmentPart(structure: any): boolean {
  if (!structure) return false;
  if (structure.disposition === "attachment") return true; // also an attached message/rfc822, which has childNodes
  if (structure.childNodes) return structure.childNodes.some(hasAttachmentPart);
  return countsAsAttachment({
    disposition: structure.disposition,
    contentType: structure.type,
    hasContentId: Boolean(structure.id),
    hasName: Boolean(structure.dispositionParameters?.filename || structure.parameters?.name),
  });
}

/**
 * Messages in the currently selected mailbox that match `filters`, without the ones `scope`
 * hides. Never widens the selection: a criterion the server cannot apply raises an error instead
 * of being dropped, and hidden messages are filtered out by their fetched labels, exactly, never
 * by a server-side label search.
 */
export async function selectByFilter(client: ImapFlow, filters: SearchFilters, scope: MessageScope): Promise<FilterSelection> {
  const compiled = compileSearch(filters, client.mailbox, { gmail: client.capabilities.has("X-GM-EXT-1") });
  let uids: number[];
  try {
    uids = await strictSearch(client, compiled.query);
  } catch (err) {
    if (err instanceof ImapOperationError && hasNonAsciiText(filters)) {
      throw new ImapOperationError(
        `${err.message} The server may not support searching for non-ASCII text (umlauts etc.); try an ASCII-only search term.`,
        err.operation,
      );
    }
    throw err;
  }

  // Before the attachment check: it reads body structures, which hidden messages never show
  let labelScanLimited = false;
  const check = uids.length > 0 ? await scope.labelCheck(client) : null;
  if (check) {
    const candidates = uids.slice(-LABEL_SCAN_LIMIT);
    labelScanLimited = candidates.length < uids.length;
    uids = await withoutHiddenLabels(client, candidates, check);
  }

  let attachmentScanLimited = false;
  if (compiled.hasAttachment !== undefined && uids.length > 0) {
    const candidates = uids.slice(-ATTACHMENT_SCAN_LIMIT);
    attachmentScanLimited = candidates.length < uids.length;
    const keep: number[] = [];
    for await (const msg of client.fetch(candidates, { uid: true, bodyStructure: true }, { uid: true })) {
      if (hasAttachmentPart(msg.bodyStructure) === compiled.hasAttachment) keep.push(msg.uid);
    }
    uids = keep.sort((a, b) => a - b);
  }
  return { uids, applied: compiled.applied, attachmentScanLimited, labelScanLimited };
}
