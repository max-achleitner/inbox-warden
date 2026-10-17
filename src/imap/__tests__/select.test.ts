import { describe, it, expect, beforeEach } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { hasAttachmentPart, keywordsSupported, selectByFilter } from "../select.js";

describe("hasAttachmentPart", () => {
  it("counts named parts whatever their disposition, but not images embedded by Content-ID", () => {
    const text = { type: "text/plain" };
    const inlinePdf = { type: "application/pdf", disposition: "inline", dispositionParameters: { filename: "Angebot.pdf" } };
    const namedPdf = { type: "application/pdf", parameters: { name: "Angebot.pdf" } };
    const logo = { type: "image/png", disposition: "inline", id: "<logo@x>", dispositionParameters: { filename: "logo.png" } };
    expect(hasAttachmentPart({ type: "multipart/mixed", childNodes: [text, inlinePdf] })).toBe(true);
    expect(hasAttachmentPart({ type: "multipart/mixed", childNodes: [text, namedPdf] })).toBe(true);
    expect(hasAttachmentPart({ type: "multipart/related", childNodes: [{ type: "text/html" }, logo] })).toBe(false);
    expect(hasAttachmentPart({ type: "text/plain", disposition: "inline" })).toBe(false);
    const attachedEml = { type: "message/rfc822", disposition: "attachment", childNodes: [text] };
    expect(hasAttachmentPart({ type: "multipart/mixed", childNodes: [text, attachedEml] })).toBe(true);
  });
});

describe("selectByFilter", () => {
  let imap: FakeImap;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.addMessage("INBOX", await buildRaw({ from: "a@x.com", to: "me@x.com", subject: "plain", text: "x" }));
    imap.addMessage(
      "INBOX",
      await buildRaw({
        from: "a@x.com",
        to: "me@x.com",
        subject: "with pdf",
        text: "x",
        attachments: [{ filename: "a.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" }],
      }),
    );
    await imap.getMailboxLock("INBOX");
  });

  it("filters by attachment both ways", async () => {
    expect((await selectByFilter(imap.asClient(), { hasAttachment: true })).uids).toEqual([2]);
    expect((await selectByFilter(imap.asClient(), { hasAttachment: false })).uids).toEqual([1]);
  });

  it("treats an inline file (Apple Mail PDFs) as an attachment, so hasAttachment=false never selects it", async () => {
    imap.addMessage(
      "INBOX",
      await buildRaw({
        from: "a@x.com",
        to: "me@x.com",
        subject: "inline pdf",
        text: "x",
        attachments: [{ filename: "scan.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf", contentDisposition: "inline" }],
      }),
    );
    expect((await selectByFilter(imap.asClient(), { hasAttachment: false })).uids).toEqual([1]);
    expect((await selectByFilter(imap.asClient(), { hasAttachment: true })).uids).toEqual([2, 3]);
  });

  it("adds the non-ASCII hint when the server rejects the search", async () => {
    imap.failOn("search", "false");
    await expect(selectByFilter(imap.asClient(), { subject: "Größe" })).rejects.toThrow(/non-ASCII/);
  });
});

describe("keywordsSupported", () => {
  it("reads PERMANENTFLAGS", () => {
    expect(keywordsSupported({ permanentFlags: new Set(["\\Seen", "\\*"]) } as any)).toBe(true);
    expect(keywordsSupported({ permanentFlags: new Set(["\\Seen", "\\Flagged"]) } as any)).toBe(false);
    expect(keywordsSupported({ permanentFlags: new Set(["*"]) } as any)).toBe(false);
    expect(keywordsSupported(false)).toBe(false);
  });
});
