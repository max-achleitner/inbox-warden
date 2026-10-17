import { describe, it, expect } from "vitest";
import { SelectionError, SelectionStore, actionKey, hashUids, type Selection } from "../selection.js";

const base: Selection = {
  accountId: "main",
  folder: "INBOX",
  uidValidity: "1000",
  uids: [3, 1, 2, 2],
  action: { type: "move", destination: "Archive" },
};

describe("SelectionStore", () => {
  it("returns the previewed selection once, with sorted unique UIDs", () => {
    const store = new SelectionStore();
    const { token } = store.issue(base);
    const sel = store.consume(token, { accountId: "main", folder: "INBOX", action: { destination: "Archive", type: "move" } });
    expect(sel.uids).toEqual([1, 2, 3]);
    expect(() => store.consume(token, { accountId: "main", folder: "INBOX", action: base.action })).toThrow(/already used/);
  });

  it("rejects a token for a different action and burns it", () => {
    const store = new SelectionStore();
    const { token } = store.issue(base);
    expect(() => store.consume(token, { accountId: "main", folder: "INBOX", action: { type: "delete" } })).toThrow(SelectionError);
    expect(() => store.consume(token, { accountId: "main", folder: "INBOX", action: base.action })).toThrow(/already used/);
  });

  it("rejects a token for a different account or folder", () => {
    const store = new SelectionStore();
    const a = store.issue(base).token;
    const b = store.issue(base).token;
    expect(() => store.consume(a, { accountId: "other", folder: "INBOX", action: base.action })).toThrow(/different account/);
    expect(() => store.consume(b, { accountId: "main", folder: "Archive", action: base.action })).toThrow(/different account/);
  });

  it("expires tokens after 10 minutes", () => {
    let now = 1_000_000;
    const store = new SelectionStore(() => now);
    const { token, expiresAt } = store.issue(base);
    expect(expiresAt).toBe(new Date(1_000_000 + 600_000).toISOString());
    now += 600_001;
    expect(() => store.consume(token, { accountId: "main", folder: "INBOX", action: base.action })).toThrow(/expired/);
  });

  it("prunes expired entries when issuing", () => {
    let now = 0;
    const store = new SelectionStore(() => now);
    store.issue(base);
    now = 700_000;
    store.issue(base);
    expect(store.size).toBe(1);
  });
});

describe("helpers", () => {
  it("actionKey ignores key order", () => {
    expect(actionKey({ type: "addKeyword", keyword: "$Done" })).toBe(actionKey({ keyword: "$Done", type: "addKeyword" } as any));
  });

  it("hashUids ignores order", () => {
    expect(hashUids([3, 1, 2])).toBe(hashUids([1, 2, 3]));
  });
});
