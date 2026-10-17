import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { simpleParser } from "mailparser";
import type { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as replyDraft from "../reply-draft.js";

const ME = "max@firma.example";


describe("reply_draft", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    const t = createTestApp();
    imap = t.imap();
    h = await t.connect(replyDraft.register);
  });

  afterEach(async () => {
    await h.close();
  });

  it("answers the Reply-To address, threads and quotes", async () => {
    imap.addMessage(
      "INBOX",
      await buildRaw({
        from: "Webformular <noreply@shop.example>",
        replyTo: "Hans Müller <hans@example.com>",
        to: ME,
        subject: "Anfrage Lieferzeit",
        text: "Wann kommt die Ware?",
        messageId: "<orig-1@shop.example>",
      }),
    );

    const res = await h.call("reply_draft", { uid: 1, body: "Nächste Woche.", language: "de" });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ to: "Hans Müller <hans@example.com>", subject: "Re: Anfrage Lieferzeit" });

    const draft = await simpleParser(imap.message("Drafts", res.json.uid)!.raw);
    expect(draft.inReplyTo).toBe("<orig-1@shop.example>");
    expect(draft.references).toBe("<orig-1@shop.example>");
    expect(draft.text).toContain("Nächste Woche.");
    expect(draft.text).toContain("> Wann kommt die Ware?");
  });

  it("can skip the quote", async () => {
    imap.addMessage("INBOX", await buildRaw({ from: "a@example.com", to: ME, subject: "x", text: "original" }));
    const res = await h.call("reply_draft", { uid: 1, body: "kurz", quoteOriginal: false });
    const draft = await simpleParser(imap.message("Drafts", res.json.uid)!.raw);
    expect(draft.text?.trim()).toBe("kurz");
  });

  it("returns a clear error for an unknown UID", async () => {
    const res = await h.call("reply_draft", { uid: 99, body: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No message with UID 99/);
  });
});
