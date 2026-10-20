import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as getQuota from "../get-quota.js";

describe("get_quota", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    const t = createTestApp();
    imap = t.imap();
    h = await t.connect(getQuota.register);
  });

  afterEach(async () => {
    await h.close();
  });

  it("reports storage and message limits (imapflow 2 field names)", async () => {
    imap.quota = { path: "INBOX", storage: { usage: 512, limit: 2048 }, message: { usage: 10, limit: 1000 } };
    const res = await h.call("get_quota");
    expect(res.json).toEqual({ path: "INBOX", usage: 512, limit: 2048, usagePercent: 25, messageCount: 10, messageLimit: 1000 });
  });

  it("resolves the folder like every other tool", async () => {
    imap.quota = { path: "INBOX", storage: { usage: 1, limit: 2 } };
    expect((await h.call("get_quota", { path: "inbox" })).isError).toBe(false);
    expect(imap.callsTo("getQuota")).toEqual([["INBOX"]]);
  });

  it("refuses a folder hidden by policy without asking the server", async () => {
    const t = createTestApp([{ policy: { folders: { deny: ["Privat/**"] } } }]);
    t.imap().addFolder("Privat");
    const scoped = await t.connect(getQuota.register);
    const res = await scoped.call("get_quota", { path: "Privat" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/is locked in this mailbox's settings/);
    expect(t.imap().callsTo("getQuota")).toEqual([]);
    await scoped.close();
  });

  it("says so when the server has no quota support", async () => {
    const res = await h.call("get_quota");
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ supported: false });
  });
});
