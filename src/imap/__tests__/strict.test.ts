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
  LabelCheckError,
  UNSCOPED,
  visibleUids,
  withoutHiddenLabels,
  type MessageScope,
} from "../strict.js";

/** Hides every message carrying the label "geheim". */
const SECRET_LABEL: MessageScope = { labelCheck: async () => (labels) => labels.has("geheim") };

describe("message scope (Gmail labels)", () => {
  let imap: FakeImap;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.capabilities.set("X-GM-EXT-1", true);
    imap.addMessage("INBOX", "Subject: offen\r\n\r\nbody", { labels: new Set(["Kunden"]) });
    imap.addMessage("INBOX", "Subject: zu\r\n\r\nbody", { labels: new Set(["Kunden", "geheim"]) });
    imap.addMessage("INBOX", "Subject: ohne\r\n\r\nbody", { labels: new Set() });
    await imap.getMailboxLock("INBOX");
  });

  it("visibleUids leaves out hidden messages and keeps the order", async () => {
    expect(await visibleUids(imap.asClient(), [3, 2, 1], SECRET_LABEL)).toEqual([3, 1]);
  });

  it("visibleUids sends no command when the scope cannot hide anything", async () => {
    expect(await visibleUids(imap.asClient(), [1, 2, 3], UNSCOPED)).toEqual([1, 2, 3]);
    expect(imap.callsTo("fetch")).toEqual([]);
  });

  it("existingUids reports a hidden message as missing", async () => {
    expect(await existingUids(imap.asClient(), [1, 2, 99], SECRET_LABEL)).toEqual([1]);
  });

  it("downloadMessage does not find a hidden message, like a UID that does not exist", async () => {
    const hidden = await downloadMessage(imap.asClient(), 2, "INBOX", SECRET_LABEL).catch((e: Error) => e);
    const missing = await downloadMessage(imap.asClient(), 99, "INBOX", SECRET_LABEL).catch((e: Error) => e);
    expect(hidden).toBeInstanceOf(MessageNotFoundError);
    expect((hidden as Error).message).toBe((missing as Error).message.replace("99", "2"));
    expect((await downloadMessage(imap.asClient(), 1, "INBOX", SECRET_LABEL)).toString()).toContain("Subject: offen");
    expect(imap.callsTo("download")).toEqual([]);
  });

  it("fails closed when the server answers without labels or the FETCH fails", async () => {
    for (const mode of ["false", "throw"] as const) {
      imap.failOn("labels", mode);
      await expect(visibleUids(imap.asClient(), [1, 3], SECRET_LABEL)).rejects.toBeInstanceOf(LabelCheckError);
      imap.failOn("labels", mode);
      await expect(downloadMessage(imap.asClient(), 1, "INBOX", SECRET_LABEL)).rejects.toBeInstanceOf(LabelCheckError);
    }
    expect(new LabelCheckError().message).toMatch(/Nothing was changed/);
  });

  it("skips unsolicited FETCH rows, but needs a row with labels for every UID", async () => {
    const rows = (list: Array<Record<string, unknown>>) =>
      ({ async *fetch() { for (const row of list) yield row; } }) as unknown as ImapFlow;
    const check = (labels: ReadonlySet<string>) => labels.has("geheim");
    // a flag update for another message and one without labels for a requested UID, then the real rows
    const client = rows([
      { uid: 7, flags: new Set(["\\Seen"]) },
      { uid: 1, flags: new Set(["\\Seen"]) },
      { uid: 1, labels: new Set(["Kunden"]) },
      { uid: 2, labels: new Set(["geheim"]) },
      { uid: 9, labels: new Set(["geheim"]) },
    ]);
    expect(await withoutHiddenLabels(client, [1, 2], check)).toEqual([1]);
    await expect(withoutHiddenLabels(rows([{ uid: 1, labels: new Set() }, { uid: 2, flags: new Set() }]), [1, 2], check)).rejects.toBeInstanceOf(LabelCheckError);
  });

  it("fetches labels in chunks of at most 1000 UIDs", async () => {
    const ranges: number[] = [];
    const client = {
      async *fetch(range: number[]) {
        ranges.push(range.length);
        for (const uid of range) yield { uid, labels: new Set<string>() };
      },
    } as unknown as ImapFlow;
    const uids = Array.from({ length: 2500 }, (_, i) => i + 1);
    expect(await withoutHiddenLabels(client, uids, () => false)).toHaveLength(2500);
    expect(ranges).toEqual([1000, 1000, 500]);
  });
});

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
    expect(await existingUids(imap.asClient(), [1, 2, 99], UNSCOPED)).toEqual([1, 2]);
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
    await expect(downloadMessage(imap.asClient(), 42, "INBOX", UNSCOPED)).rejects.toBeInstanceOf(MessageNotFoundError);
  });
});
