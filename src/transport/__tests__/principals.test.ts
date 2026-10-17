import { describe, it, expect } from "vitest";
import type { ToolCallEvent } from "../../context.js";
import { fakeApp } from "./fake-app.js";
import { AccountNotFoundError } from "../../context.js";
import { allowedAccountIds, scopeAppContext, type Principal } from "../auth/principals.js";

const bearer = (tokenId: string): Principal => ({ kind: "bearer", id: `token:${tokenId}`, tokenId, groups: [], scopes: [] });
const oauth = (extra: Partial<Principal>): Principal => ({ kind: "oauth", id: "oauth:u1", sub: "u1", groups: [], scopes: [], ...extra });

describe("allowedAccountIds", () => {
  const all = ["office", "private", "shop"];

  it("gives bearer tokens every account when no rules are configured", () => {
    expect(allowedAccountIds(bearer("laptop"), [], all)).toEqual(all);
  });

  it("gives OAuth principals nothing when no rules are configured", () => {
    expect(allowedAccountIds(oauth({}), [], all)).toEqual([]);
  });

  it("unions matching rules, honours '*' and ignores unknown ids", () => {
    const rules = [
      { match: { email: "max@firma.example" }, accounts: ["office", "ghost"] },
      { match: { group: "g-shop" }, accounts: ["shop"] },
      { match: { tokenId: "routine" }, accounts: ["*"] },
    ];
    expect(allowedAccountIds(oauth({ email: "MAX@firma.example", groups: ["g-shop"] }), rules, all)).toEqual(["office", "shop"]);
    expect(allowedAccountIds(bearer("routine"), rules, all)).toEqual(all);
    expect(allowedAccountIds(bearer("other"), rules, all)).toEqual([]);
  });

  it("requires every key of a match to fit (AND)", () => {
    const rules = [{ match: { email: "max@firma.example", group: "g-admin" }, accounts: ["office"] }];
    expect(allowedAccountIds(oauth({ email: "max@firma.example" }), rules, all)).toEqual([]);
  });
});

describe("scopeAppContext", () => {
  it("hides other mailboxes and refuses them without revealing whether they exist", () => {
    const view = scopeAppContext(fakeApp(["office", "private"], []), oauth({}), ["private"]);
    expect([...view.accounts.keys()]).toEqual(["private"]);
    expect(view.resolveAccount(undefined).id).toBe("private");
    expect(() => view.resolveAccount("office")).toThrow(AccountNotFoundError);
    expect(() => view.resolveAccount("nope")).toThrow('There is no mail account "nope". Available accounts: "private".');
    expect(() => view.resolveAccount("office")).toThrow('There is no mail account "office". Available accounts: "private".');
    expect(view.anyAccountAllows("send")).toBe(false);
  });

  it("trims the account argument like the local server, so an empty string means the default", () => {
    const view = scopeAppContext(fakeApp(["office", "private"], [], "private"), oauth({}), ["private"]);
    expect(view.resolveAccount("").id).toBe("private");
    expect(view.resolveAccount("  ").id).toBe("private");
    expect(view.resolveAccount(" private ").id).toBe("private");
  });

  it("falls back to the first allowed mailbox when the configured default is not allowed", () => {
    const view = scopeAppContext(fakeApp(["office", "private", "shop"], [], "office"), oauth({}), ["private", "shop"]);
    expect(view.defaultAccountId).toBe("private");
    expect(view.resolveAccount(undefined).id).toBe("private");
  });

  it("keeps the configured default when it is allowed", () => {
    const view = scopeAppContext(fakeApp(["office", "private", "shop"], [], "shop"), oauth({}), ["private", "shop"]);
    expect(view.defaultAccountId).toBe("shop");
    expect(view.resolveAccount(undefined).id).toBe("shop");
  });

  it("stamps the principal on every audit event", async () => {
    const events: ToolCallEvent[] = [];
    const view = scopeAppContext(fakeApp(["office"], events), bearer("routine"), ["office"]);
    await view.observers[0].onToolCall({ tool: "search_emails", accountId: "office", tier: "read", outcome: "success", durationMs: 3, details: { folder: "INBOX" } });
    expect(events[0].details).toEqual({ folder: "INBOX", principal: "token:routine", principalKind: "bearer" });
  });

  it("uses the policy-aware tier check: a drafts-only mailbox does not enable sending", () => {
    const app = fakeApp(["office", "drafts"], []);
    expect(scopeAppContext(app, bearer("a"), ["drafts"]).anyAccountAllows("send")).toBe(false);
    expect(scopeAppContext(app, bearer("b"), ["office", "drafts"]).anyAccountAllows("send")).toBe(true);
    expect(scopeAppContext(app, bearer("c"), ["drafts"]).anyAccountAllows("write")).toBe(true);
  });

  it("inherits members it does not override", () => {
    const base = fakeApp(["office"], []);
    const view = scopeAppContext(base, bearer("x"), ["office"]);
    expect(view.config).toBe(base.config);
  });
});
