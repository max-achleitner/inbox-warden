import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
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

  it("permanently removes previewed messages when the folder is Trash", async () => {
    const { imap, h } = await setup();
    imap.addMessage("Trash", raw("spam@junk.example", "old"));
    const preview = await h.call("delete_email", { folder: "Trash", filter: {} });
    const res = await h.call("delete_email", { folder: "Trash", confirmToken: preview.json.confirmToken });
    expect(res.json).toMatchObject({ action: "expunged", count: 1 });
    expect(imap.uidsIn("Trash")).toEqual([]);
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
