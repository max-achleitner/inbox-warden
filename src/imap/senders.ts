import type { ImapFlow } from "imapflow";
import { envelopeDate } from "./envelope.js";
import { scanSubjectOnly, type InjectionScanResult } from "../security/injection-detector.js";

export type SenderGrouping = "address" | "domain";

export interface SenderGroup {
  /** Lower-cased sender address, or its domain when grouped by domain. */
  sender: string;
  /** Display name of the newest message from this address (address grouping only). */
  name?: string;
  count: number;
  oldest?: string;
  newest?: string;
  /** Present when the display name looks like a manipulation attempt. */
  _injectionScan?: InjectionScanResult;
}

export interface SenderSummary {
  senders: SenderGroup[];
  /** What the limit left out. */
  otherSenders?: { senders: number; messages: number };
}

/** Most messages whose envelopes summarize_senders reads (the newest ones). */
export const SENDER_SCAN_LIMIT = 5000;

const UNKNOWN = "(unknown)";

/**
 * Sender statistics for messages in the currently selected mailbox, most frequent sender first.
 * Reads only envelopes, never bodies.
 */
export async function summarizeSenders(
  client: ImapFlow,
  uids: number[],
  opts: { groupBy: SenderGrouping; limit: number },
): Promise<SenderSummary> {
  const groups = new Map<string, SenderGroup & { nameUid: number }>();
  if (uids.length > 0) {
    for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
      const from = msg.envelope?.from?.[0];
      const address = (from?.address ?? "").toLowerCase();
      const key = opts.groupBy === "domain" ? address.split("@")[1] || UNKNOWN : address || UNKNOWN;
      const date = envelopeDate(msg.envelope?.date);
      const group = groups.get(key) ?? { sender: key, count: 0, nameUid: -1 };
      group.count += 1;
      if (date && (!group.oldest || date < group.oldest)) group.oldest = date;
      if (date && (!group.newest || date > group.newest)) group.newest = date;
      if (opts.groupBy === "address" && from?.name && msg.uid > group.nameUid) {
        group.name = from.name;
        group.nameUid = msg.uid;
      }
      groups.set(key, group);
    }
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || a.sender.localeCompare(b.sender));
  const shown = sorted.slice(0, opts.limit).map(({ nameUid: _nameUid, ...group }) => {
    const scan = group.name ? scanSubjectOnly(group.name) : undefined;
    return {
      sender: group.sender,
      ...(group.name ? { name: group.name } : {}),
      count: group.count,
      ...(group.oldest ? { oldest: group.oldest } : {}),
      ...(group.newest ? { newest: group.newest } : {}),
      ...(scan?.hasInjection ? { _injectionScan: scan } : {}),
    };
  });
  const rest = sorted.slice(opts.limit);
  return {
    senders: shown,
    ...(rest.length > 0 ? { otherSenders: { senders: rest.length, messages: rest.reduce((sum, g) => sum + g.count, 0) } } : {}),
  };
}
