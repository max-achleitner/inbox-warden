import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as moveEmail from "../move-email.js";
import * as flagEmail from "../flag-email.js";
import * as markAsRead from "../mark-as-read.js";
import * as deleteEmail from "../delete-email.js";

describe("organizing tools", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    const t = createTestApp();
    imap = t.imap();
    imap.addFolder("Archive");
    imap.addFolder("Projects", { flags: ["\\Noselect"] });
    for (const s of ["a", "b", "c"]) imap.addMessage("INBOX", `Subject: ${s}\r\n\r\nbody`);
    h = await t.connect(moveEmail.register, flagEmail.register, markAsRead.register, deleteEmail.register);
  });

  afterEach(async () => {
    await h.close();
  });

  describe("move_email", () => {
    it("moves only existing UIDs and reports missing ones", async () => {
      const res = await h.call("move_email", { uids: [1, 99], destination: "archive" });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ to: "Archive", moved: 1, missingUids: [99] });
      expect(imap.uidsIn("INBOX")).toEqual([2, 3]);
    });

    it("refuses a destination that does not exist", async () => {
      const res = await h.call("move_email", { uids: [1], destination: "Archiv 2025" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/does not exist/);
      expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3]);
    });

    it("refuses a \\Noselect parent folder", async () => {
      const res = await h.call("move_email", { uids: [1], destination: "Projects" });
      expect(res.isError).toBe(true);
      expect(imap.callsTo("messageMove")).toHaveLength(0);
    });

    it("reports a server refusal as an error, not success", async () => {
      imap.failOn("messageMove", "false");
      const res = await h.call("move_email", { uids: [1], destination: "Archive" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Nothing was moved/);
    });
  });

  describe("flag_email", () => {
    it("normalises flag spelling", async () => {
      const res = await h.call("flag_email", { uids: [1], action: "add", flags: ["flagged"] });
      expect(res.isError).toBe(false);
      expect(imap.message("INBOX", 1)!.flags.has("\\Flagged")).toBe(true);
    });

    it("refuses custom keywords on servers that cannot store them", async () => {
      imap.folders.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged", "\\Deleted", "\\Answered", "\\Draft"]);
      const res = await h.call("flag_email", { uids: [1], action: "add", flags: ["$Erledigt"] });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/does not support the keyword/);
      expect(imap.callsTo("messageFlagsAdd")).toHaveLength(0);
    });

    it("cannot be used to delete (\\Deleted is reserved for delete_email)", async () => {
      const res = await h.call("flag_email", { uids: [1], action: "add", flags: ["\\Deleted"] });
      expect(res.isError).toBe(true);
      expect(imap.message("INBOX", 1)!.flags.has("\\Deleted")).toBe(false);
    });

    it("rejects keywords with spaces", async () => {
      const res = await h.call("flag_email", { uids: [1], action: "add", flags: ["to do"] });
      expect(res.isError).toBe(true);
    });
  });

  describe("mark_as_read", () => {
    it("reports a server refusal as an error", async () => {
      imap.failOn("messageFlagsAdd", "false");
      const res = await h.call("mark_as_read", { uids: [1] });
      expect(res.isError).toBe(true);
    });

    it("marks existing messages and lists missing UIDs", async () => {
      const res = await h.call("mark_as_read", { uids: [2, 7] });
      expect(res.json).toMatchObject({ uids: [2], missingUids: [7], markedAs: "read" });
      expect(imap.message("INBOX", 2)!.flags.has("\\Seen")).toBe(true);
    });
  });

  describe("delete_email", () => {
    it("moves to Trash", async () => {
      const res = await h.call("delete_email", { uids: [1] });
      expect(res.json).toMatchObject({ action: "moved_to_trash", trashFolder: "Trash" });
      expect(imap.uidsIn("Trash")).toEqual([1]);
    });

    it("refuses to delete permanently from Trash", async () => {
      imap.addMessage("Trash", "Subject: old\r\n\r\n");
      const res = await h.call("delete_email", { folder: "Trash", uids: [1] });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/never deletes them permanently/);
      expect(res.text).toMatch(/own mail program/);
      expect(res.text).toMatch(/Nothing was deleted/);
      expect(imap.uidsIn("Trash")).toEqual([1]);
      expect(imap.callsTo("messageDelete")).toHaveLength(0);
    });

    it("refuses to delete from a folder below Trash", async () => {
      imap.addFolder("Trash/Old");
      imap.addMessage("Trash/Old", "Subject: old\r\n\r\n");
      const res = await h.call("delete_email", { folder: "Trash/Old", uids: [1] });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Nothing was deleted/);
      expect(imap.uidsIn("Trash/Old")).toEqual([1]);
      expect(imap.callsTo("messageMove")).toHaveLength(0);
    });

    it("refuses when the account has no Trash folder instead of deleting permanently", async () => {
      imap.folders.delete("Trash");
      const res = await h.call("delete_email", { uids: [1] });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/no Trash folder/);
      expect(res.text).toMatch(/Nothing was deleted/);
      expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3]);
      expect(imap.callsTo("messageDelete")).toHaveLength(0);
    });

    it("refuses a filter delete when the account has no Trash folder", async () => {
      imap.folders.delete("Trash");
      const res = await h.call("delete_email", { filter: { all: true } });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/no Trash folder/);
      expect(res.text).not.toMatch(/confirmToken/);
      expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3]);
    });

    it("reports a failed move to Trash as an error", async () => {
      imap.failOn("messageMove", "false");
      const res = await h.call("delete_email", { uids: [1] });
      expect(res.isError).toBe(true);
      expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3]);
    });
  });
});
