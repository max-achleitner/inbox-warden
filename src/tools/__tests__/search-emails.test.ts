import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as searchEmails from "../search-emails.js";

describe("search_emails", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    const t = createTestApp();
    imap = t.imap();
    imap.addMessage("INBOX", await buildRaw({ from: "anna@example.com", to: "me@example.com", subject: "Angebot" }), {
      internalDate: new Date("2026-01-10T09:00:00Z"),
    });
    imap.addMessage("INBOX", await buildRaw({ from: "bob@example.com", to: "me@example.com", subject: "Rechnung" }), {
      internalDate: new Date("2026-02-10T09:00:00Z"),
    });
    imap.addMessage("INBOX", await buildRaw({ from: "anna@example.com", to: "me@example.com", subject: "Termin" }), {
      internalDate: new Date("2026-03-10T09:00:00Z"),
    });
    h = await t.connect(searchEmails.register);
  });

  afterEach(async () => {
    await h.close();
  });

  it("returns only matching messages and echoes the applied filters", async () => {
    const res = await h.call("search_emails", { from: "anna@example.com" });
    expect(res.isError).toBe(false);
    expect(res.json.totalMatches).toBe(2);
    expect(res.json.appliedFilters).toEqual({ from: "anna@example.com" });
    expect(res.json.messages.map((m: any) => m.uid)).toEqual([3, 1]);
  });

  it("compact mode leaves out Message-ID, recipients and size", async () => {
    const res = await h.call("search_emails", { from: "anna@example.com", compact: true, includePreview: false });
    expect(res.isError).toBe(false);
    const [first] = res.json.messages;
    expect(Object.keys(first).sort()).toEqual(["date", "flags", "from", "hasAttachment", "subject", "uid"]);
    expect(first.from).toEqual([{ name: "", address: "anna@example.com" }]);
  });

  it("fails instead of returning every email when the server rejects the search", async () => {
    imap.failOn("search", "false");
    const res = await h.call("search_emails", { from: "anna@example.com" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/rejected the search/);
    expect(res.json).toBeUndefined();
  });

  it("fails instead of falling back to all emails when search throws", async () => {
    imap.failOn("search", "throw");
    const res = await h.call("search_emails", { subject: "Angebot" });
    expect(res.isError).toBe(true);
    expect(res.text).not.toMatch(/"messages"/);
  });

  it("adds a hint when a non-ASCII search is rejected", async () => {
    imap.failOn("search", "false");
    const res = await h.call("search_emails", { subject: "Größe" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/non-ASCII/);
  });

  it("rejects a natural-language date instead of ignoring it", async () => {
    const res = await h.call("search_emails", { since: "last week" });
    expect(res.isError).toBe(true);
    expect(imap.callsTo("search")).toHaveLength(0);
  });

  it("refuses a keyword search on a server without custom keywords", async () => {
    imap.folders.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged", "\\Deleted"]);
    const res = await h.call("search_emails", { keyword: "$Erledigt" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not support the custom keyword/);
  });

  it("reports an unknown folder with suggestions instead of searching elsewhere", async () => {
    imap.addFolder("Archiv");
    const res = await h.call("search_emails", { folder: "Archive" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not exist/);
  });

  it("returns uidValidity as a string", async () => {
    const res = await h.call("search_emails", {});
    expect(typeof res.json.uidValidity).toBe("string");
  });

  it("still lists a message whose Date header cannot be parsed", async () => {
    imap.addMessage("INBOX", "From: spam@example.com\r\nSubject: Gewinn\r\nDate: garbage\r\n\r\nx");
    const res = await h.call("search_emails", {});
    expect(res.isError).toBe(false);
    const spam = res.json.messages.find((m: any) => m.subject === "Gewinn");
    expect(spam).toBeDefined();
    expect(spam.date).toBeUndefined();
  });
});
