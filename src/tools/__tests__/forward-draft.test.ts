import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as forwardDraft from "../forward-draft.js";

async function setup() {
  const t = createTestApp([
    { identities: [{ email: "max@firma.example", name: "Max Achleitner", signature: "Max Achleitner\nBeispiel IT" }] },
  ]);
  t.imap().addMessage(
    "INBOX",
    await buildRaw({
      from: "Lieferant <l@example.com>",
      to: "max@firma.example",
      subject: "Rechnung 4711",
      text: "Anbei die Rechnung.",
      date: new Date("2026-01-15T10:00:00Z"),
      attachments: [{ filename: "Rechnung_4711.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" }],
    }),
  );
  return { t, h: await t.connect(forwardDraft.register) };
}

describe("forward_draft", () => {
  it("creates an inline forward with the original attachments, German prefix and signature", async () => {
    const { t, h } = await setup();
    const res = await h.call("forward_draft", { uid: 1, to: "buchhaltung@firma.example", body: "Bitte bezahlen.", language: "de" });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ subject: "WG: Rechnung 4711", mode: "inline", attachments: ["Rechnung_4711.pdf"] });

    const draft = await simpleParser(t.imap().message("Drafts", res.json.uid)!.raw);
    expect(draft.from?.value[0]).toEqual({ name: "Max Achleitner", address: "max@firma.example" });
    const text = draft.text ?? "";
    expect(text.startsWith("Bitte bezahlen.")).toBe(true);
    expect(text.indexOf("Beispiel IT")).toBeLessThan(text.indexOf("Weitergeleitete Nachricht"));
    expect(text).toContain("Von: Lieferant <l@example.com>");
    expect(text).toContain("Anbei die Rechnung.");
    expect(draft.attachments.map((a) => a.filename)).toEqual(["Rechnung_4711.pdf"]);
    await h.close();
  });

  it("forwards the original unchanged as an .eml attachment", async () => {
    const { t, h } = await setup();
    const res = await h.call("forward_draft", { uid: 1, to: "x@example.com", mode: "attachment", signature: false });
    expect(res.json.subject).toBe("Fwd: Rechnung 4711");
    const draft = await simpleParser(t.imap().message("Drafts", res.json.uid)!.raw);
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0]).toMatchObject({ filename: "Rechnung 4711.eml", contentType: "message/rfc822" });
    await h.close();
  });

  it("leaves the hidden Bcc recipients out of an attached original", async () => {
    const { t, h } = await setup();
    t.imap().addMessage(
      "Sent",
      await buildRaw({ from: "max@firma.example", to: "kunde@example.com", bcc: "anwalt@example.com", subject: "Vertrag", text: "Entwurf" }),
    );
    const res = await h.call("forward_draft", { folder: "Sent", uid: 1, to: "x@example.com", mode: "attachment", signature: false });
    expect(res.isError).toBe(false);
    const draft = await simpleParser(t.imap().message("Drafts", res.json.uid)!.raw);
    const attached = draft.attachments[0].content.toString("utf8");
    expect(attached).toContain("Subject: Vertrag");
    expect(attached).not.toMatch(/^bcc:/im);
    expect(attached).not.toContain("anwalt@example.com");
    await h.close();
  });

  it("refuses a sender that is not one of the account's identities", async () => {
    const { t, h } = await setup();
    const res = await h.call("forward_draft", { uid: 1, to: "x@example.com", from: "ceo@other.example" });
    expect(res.isError).toBe(true);
    expect(t.imap().uidsIn("Drafts")).toEqual([]);
    await h.close();
  });

  it("reports an unknown UID", async () => {
    const { h } = await setup();
    const res = await h.call("forward_draft", { uid: 99, to: "x@example.com" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No message with UID 99/);
    await h.close();
  });
});
