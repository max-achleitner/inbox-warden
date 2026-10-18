import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as organizeByFilter from "../organize-by-filter.js";
import * as deleteEmail from "../delete-email.js";
import * as searchEmails from "../search-emails.js";

function raw(from: string, subject: string): string {
  return `From: ${from}\r\nTo: max@firma.example\r\nSubject: ${subject}\r\nDate: Thu, 15 Jan 2026 10:00:00 +0000\r\n\r\nbody`;
}

async function setup() {
  const t = createTestApp();
  const imap = t.imap();
  imap.addFolder("Archive");
  imap.addMessage("INBOX", raw("news@shop.example", "n1"));
  imap.addMessage("INBOX", raw("anna@example.com", "wichtig"));
  const h = await t.connect(organizeByFilter.register, deleteEmail.register, searchEmails.register);
  return { imap, h };
}

// A dropped filter key widens the selection, up to the whole folder (seen with a client holding a stale schema).
describe("unknown parameters are rejected, never silently dropped", () => {
  it("organize_by_filter refuses an unknown filter key instead of previewing the whole folder", async () => {
    const { imap, h } = await setup();
    const res = await h.call("organize_by_filter", {
      filter: { gmailQuerry: "from:news@shop.example" },
      action: { type: "move", destination: "Archive" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/gmailQuerry/);
    expect(res.json?.confirmToken).toBeUndefined();
    expect(imap.uidsIn("INBOX")).toEqual([1, 2]);
    await h.close();
  });

  it("delete_email refuses an unknown filter key", async () => {
    const { h } = await setup();
    const res = await h.call("delete_email", { filter: { sender: "news@shop.example" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/sender/);
    await h.close();
  });

  it("search_emails refuses an unknown top-level parameter instead of returning every message", async () => {
    const { h } = await setup();
    const res = await h.call("search_emails", { fromAddress: "news@shop.example" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/fromAddress/);
    await h.close();
  });

  it("still accepts the optional account parameter", async () => {
    const { h } = await setup();
    const res = await h.call("search_emails", { account: "main", from: "news@shop.example" });
    expect(res.isError).toBe(false);
    expect(res.json.totalMatches).toBe(1);
    await h.close();
  });
});
