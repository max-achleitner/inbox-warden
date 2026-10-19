import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { selectionStore } from "../../bulk/run.js";
import * as deleteEmail from "../delete-email.js";

function raw(from: string, subject: string): string {
  return `From: ${from}\r\nTo: max@firma.example\r\nSubject: ${subject}\r\n\r\nbody`;
}

async function setup() {
  const t = createTestApp();
  const imap = t.imap();
  for (const s of ["a", "b"]) imap.addMessage("INBOX", raw("spam@junk.example", s));
  imap.addMessage("INBOX", raw("chef@firma.example", "keep"));
  const h = await t.connect(deleteEmail.register);
  return { imap, h };
}

describe("delete_email with filter", () => {
  it("previews, then moves exactly the previewed messages to Trash", async () => {
    const { imap, h } = await setup();
    const preview = await h.call("delete_email", { filter: { from: "spam@junk.example" } });
    expect(preview.json).toMatchObject({ preview: true, count: 2, operation: { type: "delete" } });
    expect(imap.uidsIn("Trash")).toEqual([]);
    const res = await h.call("delete_email", { confirmToken: preview.json.confirmToken });
    expect(res.json).toMatchObject({ success: true, count: 2, action: "moved_to_trash", trashFolder: "Trash" });
    expect(imap.uidsIn("INBOX")).toEqual([3]);
    await h.close();
  });

  it("refuses to preview a permanent delete in Trash", async () => {
    const { imap, h } = await setup();
    imap.addMessage("Trash", raw("spam@junk.example", "old"));
    const preview = await h.call("delete_email", { folder: "Trash", filter: { all: true } });
    expect(preview.isError).toBe(true);
    expect(preview.text).toMatch(/never deletes them permanently/);
    expect(preview.text).toMatch(/own mail program/);
    expect(preview.text).toMatch(/Nothing was deleted/);
    expect(preview.text).not.toMatch(/confirmToken/);
    expect(imap.uidsIn("Trash")).toEqual([1]);
    expect(imap.callsTo("messageDelete")).toHaveLength(0);
    await h.close();
  });

  it("refuses to commit in Trash, even with a token issued for Trash", async () => {
    const t = createTestApp();
    const imap = t.imap();
    imap.addMessage("Trash", raw("spam@junk.example", "old"));
    const { token } = selectionStore(t.app).issue({
      accountId: "main",
      folder: "Trash",
      uidValidity: String(imap.folders.get("Trash")!.uidValidity),
      uids: [1],
      action: { type: "delete" },
    });
    const h = await t.connect(deleteEmail.register);
    const res = await h.call("delete_email", { folder: "Trash", confirmToken: token });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/never deletes them permanently/);
    expect(res.text).toMatch(/Nothing was deleted/);
    expect(imap.uidsIn("Trash")).toEqual([1]);
    expect(imap.callsTo("messageDelete")).toHaveLength(0);
    await h.close();
  });

  it("refuses a filter delete in a folder below Trash", async () => {
    const { imap, h } = await setup();
    imap.addFolder("Trash/Old");
    imap.addMessage("Trash/Old", raw("spam@junk.example", "old"));
    const preview = await h.call("delete_email", { folder: "Trash/Old", filter: { all: true } });
    expect(preview.isError).toBe(true);
    expect(preview.text).toMatch(/Nothing was deleted/);
    expect(imap.uidsIn("Trash/Old")).toEqual([1]);
    await h.close();
  });

  it("refuses an empty filter instead of previewing the whole folder", async () => {
    const { imap, h } = await setup();
    const res = await h.call("delete_email", { filter: {} });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/\{"all": true\}/);
    expect(res.text).toMatch(/Nothing was deleted/);
    expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3]);
    await h.close();
  });

  it("rejects mixing uids and filter", async () => {
    const { imap, h } = await setup();
    const res = await h.call("delete_email", { uids: [1], filter: { from: "x" } });
    expect(res.isError).toBe(true);
    expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3]);
    await h.close();
  });

  it("requires uids or a filter", async () => {
    const { h } = await setup();
    expect((await h.call("delete_email", {})).text).toMatch(/Pass uids, or a filter/);
    await h.close();
  });

  it("still deletes by uids directly", async () => {
    const { imap, h } = await setup();
    const res = await h.call("delete_email", { uids: [3] });
    expect(res.json).toMatchObject({ action: "moved_to_trash", uids: [3] });
    expect(imap.uidsIn("Trash")).toHaveLength(1);
    await h.close();
  });
});
