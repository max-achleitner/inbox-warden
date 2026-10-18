import { createHash, randomBytes } from "node:crypto";

export const SELECTION_TTL_MS = 10 * 60 * 1000;

export type BulkAction =
  | { type: "move"; destination: string; intoTrash?: true }
  | { type: "markRead" }
  | { type: "markUnread" }
  | { type: "flag" }
  | { type: "unflag" }
  | { type: "addKeyword"; keyword: string }
  | { type: "removeKeyword"; keyword: string }
  | { type: "delete" };

export interface Selection {
  accountId: string;
  folder: string;
  /** UIDVALIDITY at preview time, as a string (imapflow returns bigint). */
  uidValidity: string;
  /** Exact UIDs shown in the preview, ascending. */
  uids: number[];
  action: BulkAction;
}

interface StoredSelection extends Selection {
  uidHash: string;
  actionKey: string;
  expiresAt: number;
}

export class SelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionError";
  }
}

/** Canonical JSON of an action (sorted keys) so preview and commit compare reliably. */
export function actionKey(action: BulkAction): string {
  const entries = Object.entries(action).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

export function hashUids(uids: number[]): string {
  return createHash("sha256")
    .update([...uids].sort((a, b) => a - b).join(","))
    .digest("hex");
}

/**
 * Preview-then-commit store for bulk operations. A token is single-use, expires after 10 minutes
 * and only authorises the exact account, folder, action and UID set that was previewed.
 */
export class SelectionStore {
  private readonly entries = new Map<string, StoredSelection>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SELECTION_TTL_MS,
  ) {}

  issue(selection: Selection): { token: string; expiresAt: string } {
    this.prune();
    const uids = [...new Set(selection.uids)].sort((a, b) => a - b);
    const token = randomBytes(18).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(token, {
      ...selection,
      uids,
      uidHash: hashUids(uids),
      actionKey: actionKey(selection.action),
      expiresAt,
    });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Returns the previewed selection. The token is invalidated whether or not the checks pass. */
  consume(token: string, expected: { accountId: string; folder: string; action: BulkAction }): Selection {
    const entry = this.entries.get(token);
    this.entries.delete(token);
    if (!entry) {
      throw new SelectionError(
        "This confirmation token is unknown or was already used (tokens are also lost when the server restarts). Nothing was changed. Run the preview again.",
      );
    }
    if (entry.expiresAt < this.now()) {
      throw new SelectionError("This confirmation token has expired (tokens are valid for 10 minutes). Nothing was changed. Run the preview again.");
    }
    if (
      entry.accountId !== expected.accountId ||
      entry.folder !== expected.folder ||
      entry.actionKey !== actionKey(expected.action)
    ) {
      throw new SelectionError(
        "This confirmation token was issued for a different account, folder or action. Nothing was changed. Run the preview again with the same parameters.",
      );
    }
    if (hashUids(entry.uids) !== entry.uidHash) {
      throw new SelectionError("The stored selection is corrupted. Nothing was changed. Run the preview again.");
    }
    return {
      accountId: entry.accountId,
      folder: entry.folder,
      uidValidity: entry.uidValidity,
      uids: entry.uids,
      action: entry.action,
    };
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt < now) this.entries.delete(token);
  }
}
