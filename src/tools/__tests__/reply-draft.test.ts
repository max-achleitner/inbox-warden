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

  it("notes a Reply-To on another domain", async () => {
    imap.addMessage("INBOX", await buildRaw({ from: "rechnung@lieferant.example", replyTo: "zahlung@lieferant-pay.example", to: ME, subject: "Rechnung", text: "Bitte zahlen" }));
    const res = await h.call("reply_draft", { uid: 1, body: "ok" });
    expect(res.isError).toBe(false);
    expect(res.json.replyToNote).toContain("zahlung@lieferant-pay.example");
    expect(res.json.replyToNote).toContain("rechnung@lieferant.example");
    expect(JSON.stringify(res.json.recipientWarnings)).toContain("zahlung@lieferant-pay.example");
  });

  it("shows a look-alike Reply-To with its invisible character encoded", async () => {
    // the message builder drops the invisible character, so it is put into the raw header afterwards
    const built = await buildRaw({ from: "rechnung@paypal.example", replyTo: "zahlung@paxypal.example", to: ME, subject: "x", text: "y" });
    imap.addMessage("INBOX", Buffer.from(built.toString("utf8").replace("paxypal", "pay\u200Bpal"), "utf8"));
    const res = await h.call("reply_draft", { uid: 1, body: "ok" });
    expect(res.json.replyToNote).toContain("pay%E2%80%8Bpal.example");
  });

  it("no note for the mailbox's own Reply-To address, which the reply does not go to", async () => {
    const t = createTestApp([{ identities: [{ email: ME }, { email: "max@privat.example" }] }]);
    const h2 = await t.connect(replyDraft.register);
    t.imap().addMessage("INBOX", await buildRaw({ from: "max@privat.example", replyTo: ME, to: "kunde@kunde.example", subject: "x", text: "y" }));
    const res = await h2.call("reply_draft", { uid: 1, body: "ok" });
    expect(res.isError).toBe(false);
    expect(res.json.to).toBe("kunde@kunde.example");
    expect(res.json.replyToNote).toBeUndefined();
    await h2.close();
  });

  it("no note for a Reply-To on the sender's domain", async () => {
    imap.addMessage("INBOX", await buildRaw({ from: "news@shop.example", replyTo: "service@mail.shop.example", to: ME, subject: "x", text: "y" }));
    const res = await h.call("reply_draft", { uid: 1, body: "ok" });
    expect(res.json.replyToNote).toBeUndefined();
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

  it("cleans Claude's HTML but quotes the original unchanged", async () => {
    imap.addMessage(
      "INBOX",
      await buildRaw({ from: "kunde@example.com", to: ME, subject: "Frage", html: '<p>Hallo</p><img src="https://shop.example/banner.png">', text: "Hallo" }),
    );
    const res = await h.call("reply_draft", { uid: 1, body: "ok", html: '<p>ok</p><img src="https://evil.example/t.gif">' });
    expect(res.isError).toBe(false);
    const html = (await simpleParser(imap.message("Drafts", res.json.uid)!.raw)).html as string;
    expect(html).toContain("shop.example/banner.png");
    expect(html).not.toContain("evil.example");
    expect(res.json.remoteContentRemoved).toBe(1);
  });
});
