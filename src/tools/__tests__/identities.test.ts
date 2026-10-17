import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw, header } from "../../__tests__/helpers/messages.js";
import * as createDraft from "../create-draft.js";
import * as replyDraft from "../reply-draft.js";
import * as sendEmail from "../send-email.js";
import * as sendDraft from "../send-draft.js";

const identities = [
  { email: "max@firma.example", name: "Maximilian Achleitner", signature: "Maximilian Achleitner\nfirma.example" },
  { email: "office@firma.example", name: "Achleitner Office" },
];

describe("identities: display name, signature and aliases", () => {
  it("create_draft sends as the display name and appends the signature", async () => {
    const t = createTestApp([{ identities }]);
    const h = await t.connect(createDraft.register);
    const res = await h.call("create_draft", { to: "kunde@example.com", subject: "Angebot", body: "Anbei das Angebot." });
    expect(res.isError).toBe(false);
    const raw = t.imap().message("Drafts", res.json.uid)!.raw;
    expect(header(raw, "from")).toBe("Maximilian Achleitner <max@firma.example>");
    expect((await simpleParser(raw)).text).toBe("Anbei das Angebot.\n\n-- \nMaximilian Achleitner\nfirma.example\n");
    await h.close();
  });

  it("uses a configured alias as sender and refuses unknown senders", async () => {
    const t = createTestApp([{ identities }]);
    const h = await t.connect(createDraft.register);
    const ok = await h.call("create_draft", { to: "a@example.com", subject: "s", body: "b", from: "office@firma.example" });
    expect(header(t.imap().message("Drafts", ok.json.uid)!.raw, "from")).toBe("Achleitner Office <office@firma.example>");
    const bad = await h.call("create_draft", { to: "a@example.com", subject: "s", body: "b", from: "ceo@firma.example" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not a sender address.*max@firma.example, office@firma.example/);
    await h.close();
  });

  it("reply_draft puts the signature above the quote and uses the account locale", async () => {
    const t = createTestApp([{ identities, locale: "de" }]);
    t.imap().addMessage("INBOX", await buildRaw({ from: "Anna <anna@example.com>", to: "max@firma.example", subject: "Frage", text: "Geht das?" }));
    const h = await t.connect(replyDraft.register);
    const res = await h.call("reply_draft", { uid: 1, body: "Ja." });
    const text = (await simpleParser(t.imap().message("Drafts", res.json.uid)!.raw)).text ?? "";
    expect(text.indexOf("-- \nMaximilian Achleitner")).toBeGreaterThan(text.indexOf("Ja."));
    expect(text.indexOf("schrieb Anna <anna@example.com>:")).toBeGreaterThan(text.indexOf("-- \n"));
    await h.close();
  });

  it("reply-all never copies any of the account's own addresses", async () => {
    const t = createTestApp([{ identities }]);
    t.imap().addMessage(
      "INBOX",
      await buildRaw({ from: "anna@example.com", to: "office@firma.example", cc: "Max@Firma.example, bob@example.com", subject: "x", text: "y" }),
    );
    const h = await t.connect(replyDraft.register);
    const res = await h.call("reply_draft", { uid: 1, body: "ok", replyAll: true });
    expect(res.json.cc).toBe("bob@example.com");
    await h.close();
  });

  it("send_draft accepts drafts from an alias and uses it as envelope sender", async () => {
    const t = createTestApp([{ identities }]);
    t.imap().addMessage("Drafts", await buildRaw({ from: "office@firma.example", to: "kunde@example.com", subject: "s", text: "t" }));
    const h = await t.connect(sendDraft.register);
    const res = await h.call("send_draft", { uid: 1 });
    expect(res.isError).toBe(false);
    expect(t.capture().sent[0].envelope.from).toBe("office@firma.example");
    await h.close();
  });

  it("send_email explains when the account has no SMTP server", async () => {
    const t = createTestApp([{ smtp: false }]);
    const h = await t.connect(sendEmail.register);
    const res = await h.call("send_email", { to: "a@example.com", subject: "s", body: "b" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no outgoing \(SMTP\) server/);
    await h.close();
  });
});
