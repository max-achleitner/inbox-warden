import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as summarizeSenders from "../summarize-senders.js";

function raw(from: string, subject: string, date: string): string {
  return `From: ${from}\r\nTo: max@firma.example\r\nSubject: ${subject}\r\nDate: ${date}\r\n\r\nbody`;
}

async function setup(policy?: Record<string, unknown>) {
  const t = createTestApp(policy ? [{ policy }] : undefined);
  const imap = t.imap();
  // IMAP BEFORE/SINCE compare the internal date, so it matches the Date header here
  const add = (folder: string, from: string, subject: string, date: string) =>
    imap.addMessage(folder, raw(from, subject, date), { internalDate: new Date(date) });
  add("INBOX", "Shop News <news@shop.example>", "Sale 1", "Mon, 05 Jan 2026 10:00:00 +0000");
  add("INBOX", "Shop News <news@shop.example>", "Sale 2", "Mon, 12 Jan 2026 10:00:00 +0000");
  add("INBOX", "Shop Orders <orders@shop.example>", "Bestellung", "Tue, 13 Jan 2026 10:00:00 +0000");
  add("INBOX", "Shop News <NEWS@shop.example>", "Sale 3", "Mon, 19 Jan 2026 10:00:00 +0000");
  add("INBOX", "Anna <anna@example.com>", "Hallo", "Wed, 14 Jan 2026 10:00:00 +0000");
  imap.addFolder("Privat");
  add("Privat", "Anna <anna@example.com>", "Geheim", "Wed, 14 Jan 2026 10:00:00 +0000");
  const h = await t.connect(summarizeSenders.register);
  return { h };
}

describe("summarize_senders", () => {
  it("groups by sender address (case-insensitive), most frequent first, with date range", async () => {
    const { h } = await setup();
    const res = await h.call("summarize_senders", {});
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ folder: "INBOX", groupBy: "address", totalMatches: 5, scanned: 5 });
    expect(res.json.senders[0]).toEqual({
      sender: "news@shop.example",
      name: "Shop News",
      count: 3,
      oldest: "2026-01-05T10:00:00.000Z",
      newest: "2026-01-19T10:00:00.000Z",
    });
    expect(res.json.senders.map((s: any) => [s.sender, s.count])).toEqual([
      ["news@shop.example", 3],
      ["anna@example.com", 1],
      ["orders@shop.example", 1],
    ]);
    await h.close();
  });

  it("groups by domain", async () => {
    const { h } = await setup();
    const res = await h.call("summarize_senders", { groupBy: "domain" });
    expect(res.json.senders.map((s: any) => [s.sender, s.count])).toEqual([
      ["shop.example", 4],
      ["example.com", 1],
    ]);
    expect(res.json.senders[0].name).toBeUndefined();
    await h.close();
  });

  it("applies the same filters as search_emails and echoes them", async () => {
    const { h } = await setup();
    const res = await h.call("summarize_senders", { before: "2026-01-13" });
    expect(res.json.appliedFilters).toEqual({ before: "2026-01-13" });
    expect(res.json.senders).toEqual([expect.objectContaining({ sender: "news@shop.example", count: 2 })]);
    await h.close();
  });

  it("limits the list and says how much was left out", async () => {
    const { h } = await setup();
    const res = await h.call("summarize_senders", { limit: 1 });
    expect(res.json.senders).toHaveLength(1);
    expect(res.json.otherSenders).toEqual({ senders: 2, messages: 2 });
    await h.close();
  });

  it("refuses a folder blocked by the policy", async () => {
    const { h } = await setup({ folders: { deny: ["Privat"] } });
    const res = await h.call("summarize_senders", { folder: "Privat" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/is locked in this mailbox's settings\. Nothing was changed\./);
    await h.close();
  });

  it("is a read-only tool", async () => {
    const { h } = await setup();
    expect(await h.annotations("summarize_senders")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    await h.close();
  });
});
