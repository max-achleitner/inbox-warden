import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { connectHarness } from "../../__tests__/helpers/mcp-harness.js";
import * as organizeByFilter from "../organize-by-filter.js";

function raw(from: string, subject: string): string {
  return `From: ${from}\r\nTo: max@firma.example\r\nSubject: ${subject}\r\nDate: Thu, 15 Jan 2026 10:00:00 +0000\r\n\r\nbody`;
}

async function setup() {
  const t = createTestApp();
  const imap = t.imap();
  imap.addFolder("Archive");
  for (const s of ["n1", "n2", "n3"]) imap.addMessage("INBOX", raw("news@shop.example", s));
  imap.addMessage("INBOX", raw("anna@example.com", "wichtig"));
  const h = await t.connect(organizeByFilter.register);
  return { t, imap, h };
}

const moveNews = { filter: { from: "news@shop.example" }, action: { type: "move", destination: "archive" } };

describe("organize_by_filter", () => {
  it("previews without changing anything", async () => {
    const { imap, h } = await setup();
    const res = await h.call("organize_by_filter", moveNews);
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ preview: true, count: 3, operation: { type: "move", destination: "Archive" } });
    expect(res.json.sample.map((s: any) => s.subject)).toEqual(["n3", "n2", "n1"]);
    expect(res.json.confirmToken).toEqual(expect.any(String));
    expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3, 4]);
    await h.close();
  });

  it("applies exactly the previewed messages, not later arrivals", async () => {
    const { imap, h } = await setup();
    const preview = await h.call("organize_by_filter", moveNews);
    imap.addMessage("INBOX", raw("news@shop.example", "n4")); // arrives after the preview
    const res = await h.call("organize_by_filter", { ...moveNews, confirmToken: preview.json.confirmToken });
    expect(res.json).toMatchObject({ success: true, count: 3, destination: "Archive" });
    expect(imap.uidsIn("INBOX")).toEqual([4, 5]);
    expect(imap.uidsIn("Archive")).toHaveLength(3);
    await h.close();
  });

  it("redeems a token through another context object sharing the same config (HTTP mode wraps the context per request)", async () => {
    const { t, imap, h } = await setup();
    const preview = await h.call("organize_by_filter", moveNews);
    const perRequest = await connectHarness((server) => organizeByFilter.register(server, Object.create(t.app)));
    const res = await perRequest.call("organize_by_filter", { ...moveNews, confirmToken: preview.json.confirmToken });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ success: true, count: 3 });
    expect(imap.uidsIn("Archive")).toHaveLength(3);
    await perRequest.close();
    await h.close();
  });

  it("refuses when previewed messages disappeared in the meantime", async () => {
    const { imap, h } = await setup();
    const preview = await h.call("organize_by_filter", moveNews);
    const inbox = imap.folders.get("INBOX")!;
    inbox.messages = inbox.messages.filter((m) => m.uid !== 2); // moved by another mail client
    const res = await h.call("organize_by_filter", { ...moveNews, confirmToken: preview.json.confirmToken });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no longer in "INBOX".*Nothing was changed/);
    expect(imap.uidsIn("Archive")).toEqual([]);
    await h.close();
  });

  it("refuses when UIDVALIDITY changed", async () => {
    const { imap, h } = await setup();
    const preview = await h.call("organize_by_filter", moveNews);
    imap.folders.get("INBOX")!.uidValidity = 9999n;
    const res = await h.call("organize_by_filter", { ...moveNews, confirmToken: preview.json.confirmToken });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/reset on the server/);
    await h.close();
  });

  it("tokens are single-use and bound to the action", async () => {
    const { h } = await setup();
    const preview = await h.call("organize_by_filter", moveNews);
    const wrong = await h.call("organize_by_filter", { filter: moveNews.filter, action: { type: "markRead" }, confirmToken: preview.json.confirmToken });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/different account, folder or action/);
    const reuse = await h.call("organize_by_filter", { ...moveNews, confirmToken: preview.json.confirmToken });
    expect(reuse.text).toMatch(/already used/);
    await h.close();
  });

  it("refuses selections above the per-operation limit", async () => {
    const { imap, h } = await setup();
    for (let i = 0; i < 500; i++) imap.addMessage("INBOX", raw("news@shop.example", `bulk ${i}`));
    const res = await h.call("organize_by_filter", moveNews);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/503 messages match, more than the limit of 500/);
    await h.close();
  });

  it("warns that an empty filter selects the whole folder", async () => {
    const { h } = await setup();
    const res = await h.call("organize_by_filter", { filter: {}, action: { type: "markRead" } });
    expect(res.json.count).toBe(4);
    expect(res.json.warning).toMatch(/every message/);
    await h.close();
  });

  it("marks read and adds keywords on commit", async () => {
    const { imap, h } = await setup();
    const preview = await h.call("organize_by_filter", { filter: { from: "anna" }, action: { type: "addKeyword", keyword: "$Erledigt" } });
    await h.call("organize_by_filter", { filter: { from: "anna" }, action: { type: "addKeyword", keyword: "$Erledigt" }, confirmToken: preview.json.confirmToken });
    expect(imap.message("INBOX", 4)!.flags.has("$Erledigt")).toBe(true);
    await h.close();
  });

  it("refuses keywords the server cannot store, already at preview", async () => {
    const { imap, h } = await setup();
    imap.folders.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged", "\\Deleted"]);
    const res = await h.call("organize_by_filter", { filter: {}, action: { type: "addKeyword", keyword: "$Erledigt" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not support the keyword/);
    await h.close();
  });

  it("refuses system flags disguised as keywords", async () => {
    const { h } = await setup();
    const res = await h.call("organize_by_filter", { filter: {}, action: { type: "addKeyword", keyword: "\\Deleted" } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/system flag/);
    await h.close();
  });

  it("is annotated as destructive", async () => {
    const { h } = await setup();
    expect(await h.annotations("organize_by_filter")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    await h.close();
  });
});
