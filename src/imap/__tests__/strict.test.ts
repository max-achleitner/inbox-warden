import { describe, it, expect, beforeEach } from "vitest";
import type { ImapFlow } from "imapflow";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import {
  ImapOperationError,
  MessageNotFoundError,
  downloadMessage,
  existingUids,
  safeExpunge,
  strictMove,
  strictSearch,
  strictStatus,
  strictStoreFlags,
  unsupportedFlags,
} from "../strict.js";

describe("strict IMAP operations", () => {
  let imap: FakeImap;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.addFolder("Archive");
    imap.addMessage("INBOX", "Subject: a\r\n\r\nbody");
    imap.addMessage("INBOX", "Subject: b\r\n\r\nbody");
    await imap.getMailboxLock("INBOX");
  });

  it("strictSearch throws instead of returning false", async () => {
    imap.failOn("search", "false");
    await expect(strictSearch(imap.asClient(), { from: "x" })).rejects.toBeInstanceOf(ImapOperationError);
  });

  it("strictSearch also treats undefined (imapflow 2) as a refusal", async () => {
    const client = { search: async () => undefined } as unknown as ImapFlow;
    await expect(strictSearch(client, { all: true })).rejects.toBeInstanceOf(ImapOperationError);
  });

  it("strictStatus throws when STATUS is refused", async () => {
    await expect(strictStatus(imap.asClient(), "Nope", { messages: true })).rejects.toThrow(/refused to report the status of "Nope"/);
  });

  it("existingUids reports only UIDs present in the folder", async () => {
    expect(await existingUids(imap.asClient(), [1, 2, 99])).toEqual([1, 2]);
  });

  it("strictMove throws when the server refuses (imapflow returns false)", async () => {
    await expect(strictMove(imap.asClient(), [1], "DoesNotExist")).rejects.toThrow(/Nothing was moved/);
    expect(imap.uidsIn("INBOX")).toEqual([1, 2]);
  });

  it("strictMove returns the UID map on success", async () => {
    const map = await strictMove(imap.asClient(), [2], "Archive");
    expect(map.get(2)).toBe(1);
  });

  describe("strictMove on a server without MOVE", () => {
    beforeEach(() => {
      imap.capabilities.delete("MOVE");
      imap.addMessage("INBOX", "Subject: c\r\n\r\nbody", { flags: ["\\Deleted"] });
    });

    it("refuses without UIDPLUS when other messages are \\Deleted, before copying anything", async () => {
      imap.capabilities.delete("UIDPLUS");
      await expect(strictMove(imap.asClient(), [1], "Archive")).rejects.toThrow(/would also erase 1 other.*Nothing was moved/s);
      expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3]);
      expect(imap.uidsIn("Archive")).toEqual([]);
    });

    it("moves only the requested messages with UIDPLUS and keeps other \\Deleted messages", async () => {
      const map = await strictMove(imap.asClient(), [1], "Archive");
      expect(map.get(1)).toBe(1);
      expect(imap.uidsIn("INBOX")).toEqual([2, 3]);
      expect(imap.uidsIn("Archive")).toEqual([1]);
    });

    it("moves without UIDPLUS when no other message is \\Deleted", async () => {
      imap.capabilities.delete("UIDPLUS");
      imap.message("INBOX", 3)!.flags.delete("\\Deleted");
      await strictMove(imap.asClient(), [1], "Archive");
      expect(imap.uidsIn("INBOX")).toEqual([2, 3]);
      expect(imap.uidsIn("Archive")).toEqual([1]);
    });

    it("says the messages now exist in both folders when the copy worked but the delete failed", async () => {
      imap.failOn("messageDelete", "false");
      await expect(strictMove(imap.asClient(), [1], "Archive")).rejects.toThrow(/copied to "Archive".*both folders/s);
      expect(imap.uidsIn("Archive")).toEqual([1]);
    });
  });

  it("strictStoreFlags throws when no flag could be stored", async () => {
    imap.failOn("messageFlagsAdd", "false");
    await expect(strictStoreFlags(imap.asClient(), [1], ["\\Seen"], "add")).rejects.toThrow(/Nothing was changed/);
  });

  it("unsupportedFlags lists keywords the mailbox cannot keep", () => {
    const mailbox = { permanentFlags: new Set(["\\Seen", "\\Flagged"]) } as any;
    expect(unsupportedFlags(mailbox, ["\\Seen", "$Done"])).toEqual(["$Done"]);
    expect(unsupportedFlags({ permanentFlags: new Set(["\\*"]) } as any, ["$Done"])).toEqual([]);
  });

  it("safeExpunge refuses without UIDPLUS when other messages are already \\Deleted", async () => {
    imap.capabilities.delete("UIDPLUS");
    imap.message("INBOX", 1)!.flags.add("\\Deleted");
    await expect(safeExpunge(imap.asClient(), [2])).rejects.toThrow(/would also erase 1 other/);
    expect(imap.uidsIn("INBOX")).toEqual([1, 2]);
  });

  it("safeExpunge removes exactly the requested UID with UIDPLUS", async () => {
    imap.message("INBOX", 1)!.flags.add("\\Deleted");
    await safeExpunge(imap.asClient(), [2]);
    expect(imap.uidsIn("INBOX")).toEqual([1]);
  });

  it("downloadMessage throws MessageNotFoundError for an unknown UID", async () => {
    await expect(downloadMessage(imap.asClient(), 42, "INBOX")).rejects.toBeInstanceOf(MessageNotFoundError);
  });
});
