import { describe, it, expect } from "vitest";
import { FakeImap } from "./fake-imap.js";
import { buildRaw } from "./messages.js";

describe("FakeImap", () => {
  it("searches by from/since and returns sorted UIDs", async () => {
    const imap = new FakeImap();
    imap.addMessage("INBOX", await buildRaw({ from: "a@x.com", to: "me@x.com", subject: "one" }), {
      internalDate: new Date("2026-01-01"),
    });
    imap.addMessage("INBOX", await buildRaw({ from: "b@x.com", to: "me@x.com", subject: "two" }), {
      internalDate: new Date("2026-03-01"),
    });
    await imap.getMailboxLock("INBOX");
    expect(await imap.search({ from: "a@x.com" })).toEqual([1]);
    expect(await imap.search({ since: "2026-02-01" })).toEqual([2]);
    expect(await imap.search({ all: true })).toEqual([1, 2]);
  });

  it("returns false from move when the destination does not exist (imapflow soft failure)", async () => {
    const imap = new FakeImap();
    imap.addMessage("INBOX", "Subject: x\r\n\r\nbody");
    await imap.getMailboxLock("INBOX");
    expect(await imap.messageMove("1", "Nope", { uid: true })).toBe(false);
    expect(imap.uidsIn("INBOX")).toEqual([1]);
  });

  it("drops keywords the mailbox cannot store and returns false", async () => {
    const imap = new FakeImap();
    imap.folders.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged"]);
    imap.addMessage("INBOX", "Subject: x\r\n\r\nbody");
    await imap.getMailboxLock("INBOX");
    expect(await imap.messageFlagsAdd("1", ["$Done"], { uid: true })).toBe(false);
    expect(imap.message("INBOX", 1)!.flags.has("$Done")).toBe(false);
  });

  it("expunges every \\Deleted message when UIDPLUS is missing", async () => {
    const imap = new FakeImap();
    imap.capabilities.delete("UIDPLUS");
    imap.addMessage("INBOX", "Subject: a\r\n\r\n", { flags: ["\\Deleted"] });
    imap.addMessage("INBOX", "Subject: b\r\n\r\n");
    await imap.getMailboxLock("INBOX");
    await imap.messageDelete("2", { uid: true });
    expect(imap.uidsIn("INBOX")).toEqual([]);
  });

  describe("deselecting before RENAME/DELETE of the selected folder, like imapflow", () => {
    async function selectedWithDeletedMessage(opts?: { readOnly?: boolean }) {
      const imap = new FakeImap();
      imap.addFolder("Clients");
      imap.addMessage("Clients", "Subject: marked\r\n\r\n", { flags: ["\\Deleted"] });
      imap.addMessage("Clients", "Subject: kept\r\n\r\n");
      await imap.getMailboxLock("Clients", opts);
      return imap;
    }

    it("uses UNSELECT where the server has it and removes nothing", async () => {
      const imap = await selectedWithDeletedMessage();
      await imap.mailboxRename("Clients", "Kunden");
      expect(imap.callsTo("unselect")).toHaveLength(1);
      expect(imap.uidsIn("Kunden")).toEqual([1, 2]);
      expect(imap.mailbox).toBe(false);
    });

    it("falls back to CLOSE without UNSELECT, which expunges every \\Deleted message", async () => {
      const imap = await selectedWithDeletedMessage();
      imap.capabilities.delete("UNSELECT");
      await imap.mailboxRename("Clients", "Kunden");
      expect(imap.callsTo("close")).toHaveLength(1);
      expect(imap.uidsIn("Kunden")).toEqual([2]);
    });

    it("CLOSE removes nothing from a folder opened read-only", async () => {
      const imap = await selectedWithDeletedMessage({ readOnly: true });
      imap.capabilities.delete("UNSELECT");
      await imap.mailboxRename("Clients", "Kunden");
      expect(imap.uidsIn("Kunden")).toEqual([1, 2]);
    });

    it("leaves other folders alone", async () => {
      const imap = await selectedWithDeletedMessage();
      imap.capabilities.delete("UNSELECT");
      imap.addFolder("Empty");
      await imap.mailboxDelete("Empty");
      expect(imap.folders.has("Empty")).toBe(false);
      expect(imap.uidsIn("Clients")).toEqual([1, 2]);
      expect(imap.callsTo("close")).toHaveLength(0);
    });
  });
});
