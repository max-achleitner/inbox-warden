import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import { composeMessage } from "../compose.js";
import { getHeader } from "../headers.js";

function headerBlocks(raw: Buffer): string[] {
  // every MIME header block: top-level and per part
  return raw
    .toString("latin1")
    .split(/\r\n--[^\r\n]+\r\n/)
    .map((chunk) => chunk.split("\r\n\r\n")[0]);
}

describe("composeMessage", () => {
  const base = {
    from: { name: "Maximilian Achleitner", address: "max@firma.example" },
    to: "kunde@example.com",
    subject: "Angebot",
    text: "Hallo",
  };

  it("encodes non-ASCII attachment filenames per RFC 2231 and keeps all headers 7-bit", async () => {
    const { raw } = await composeMessage({
      ...base,
      attachments: [{ filename: "Angebot_Größe.pdf", content: Buffer.from("%PDF").toString("base64"), contentType: "application/pdf" }],
    });
    for (const block of headerBlocks(raw)) expect(block).toMatch(/^[\x00-\x7F]*$/);
    expect(raw.toString()).toMatch(/filename\*0?\*=utf-8''Angebot_Gr%C3%B6%C3%9Fe\.pdf/);
    const parsed = await simpleParser(raw);
    expect(parsed.attachments[0].filename).toBe("Angebot_Größe.pdf");
  });

  it("generates a Message-ID on the sender's domain (not @draft)", async () => {
    const { raw, messageId } = await composeMessage(base);
    expect(messageId).toMatch(/^<[^@\s]+@firma.example>$/);
    expect(getHeader(raw, "message-id")).toBe(messageId);
  });

  it("formats the From header with the display name", async () => {
    const { raw } = await composeMessage(base);
    expect(getHeader(raw, "from")).toBe("Maximilian Achleitner <max@firma.example>");
  });

  it("neutralises CRLF header injection in the subject", async () => {
    const { raw } = await composeMessage({ ...base, subject: "Hi\r\nBcc: evil@attacker.com" });
    expect(raw.toString()).not.toMatch(/^Bcc: evil/m);
  });

  it("keeps Bcc in the stored copy and puts Bcc recipients into the envelope", async () => {
    const { raw, envelope } = await composeMessage({ ...base, bcc: "chef@example.com" });
    expect(getHeader(raw, "bcc")).toBe("chef@example.com");
    expect(envelope.to).toEqual(["kunde@example.com", "chef@example.com"]);
  });

  it("keeps a forwarded .eml (message/rfc822) as an attachment", async () => {
    const inner = await composeMessage({ ...base, subject: "Inner", text: "inner" });
    const { raw } = await composeMessage({
      ...base,
      attachments: [{ filename: "Inner.eml", content: inner.raw.toString("base64"), contentType: "message/rfc822" }],
    });
    const parsed = await simpleParser(raw);
    expect(parsed.attachments.map((a) => [a.filename, a.contentType, a.contentDisposition])).toEqual([
      ["Inner.eml", "message/rfc822", "attachment"],
    ]);
  });

  it("never emits lines longer than 998 characters", async () => {
    const { raw } = await composeMessage({ ...base, text: "x".repeat(5000), html: `<p>${"y".repeat(5000)}</p>` });
    for (const line of raw.toString().split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
  });
});
