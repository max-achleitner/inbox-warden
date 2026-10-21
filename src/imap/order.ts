import type { ImapFlow } from "imapflow";

/** Cap for ordering a selection by arrival date; larger selections keep the order by UID. */
export const SORT_LIMIT = 20_000;
/** UIDs per FETCH command, to keep the command line short. */
const FETCH_CHUNK = 1000;

export interface Ordered {
  /** The UIDs, newest first. */
  uids: number[];
  sortedBy: "date" | "uid";
  /** Why the order by UID was kept (only with sortedBy "uid"). */
  reason?: "limit" | "missing-dates";
}

/**
 * `uids` (ascending, already scoped by selectByFilter) newest first by arrival date (INTERNALDATE),
 * the higher UID first on equal dates. A moved message gets a new, high UID but keeps its date, so
 * the UID alone is no order by time. Above `limit` matches, or when the server reports no date for
 * a message (`reason` says which), the order by UID (highest first) is kept and `sortedBy` says so.
 */
export async function newestFirst(client: ImapFlow, uids: number[], limit = SORT_LIMIT): Promise<Ordered> {
  const byUid = uids.slice().reverse();
  if (byUid.length < 2) return { uids: byUid, sortedBy: "date" };
  if (byUid.length > limit) return { uids: byUid, sortedBy: "uid", reason: "limit" };

  const times = new Map<number, number>();
  for (let i = 0; i < byUid.length; i += FETCH_CHUNK) {
    const chunk = byUid.slice(i, i + FETCH_CHUNK);
    for await (const msg of client.fetch(chunk, { uid: true, internalDate: true }, { uid: true })) {
      const time = msg.internalDate ? new Date(msg.internalDate).getTime() : NaN;
      if (!Number.isNaN(time)) times.set(msg.uid, time);
    }
  }
  if (byUid.some((uid) => !times.has(uid))) return { uids: byUid, sortedBy: "uid", reason: "missing-dates" };
  return { uids: byUid.sort((a, b) => times.get(b)! - times.get(a)! || b - a), sortedBy: "date" };
}

/** Comparator for already fetched messages, in the order newestFirst returns. */
export function positionComparator(ordered: number[]): (a: { uid: number }, b: { uid: number }) => number {
  const position = new Map(ordered.map((uid, i) => [uid, i]));
  return (a, b) => position.get(a.uid)! - position.get(b.uid)!;
}
