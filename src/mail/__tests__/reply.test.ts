import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { quotePlain, replyRecipients, replySubject, replyToMismatch } from "../reply.js";

async function parse(opts: Parameters<typeof buildRaw>[0]) {
  return simpleParser(await buildRaw(opts));
}

describe("replyRecipients", () => {
  it("uses Reply-To instead of a noreply From", async () => {
    const original = await parse({
      from: "Kontaktformular <noreply@shop.example>",
      replyTo: '"Müller, Hans" <hans.mueller@example.com>',
      to: "max@firma.example",
      subject: "Anfrage",
      text: "Hallo",
    });
    const { to, cc } = replyRecipients(original, ["max@firma.example"], false);
    expect(to).toEqual([{ name: "Müller, Hans", address: "hans.mueller@example.com" }]);
    expect(cc).toEqual([]);
  });

  it("reply-all removes own addresses case-insensitively and de-duplicates", async () => {
    const original = await parse({
      from: "anna@example.com",
      to: "MAX@firma.example, bob@example.com",
      cc: "anna@example.com, Carl <carl@example.com>",
      subject: "x",
      text: "y",
    });
    const { to, cc } = replyRecipients(original, ["max@firma.example"], true);
    expect(to.map((m) => m.address)).toEqual(["anna@example.com"]);
    expect(cc.map((m) => m.address)).toEqual(["bob@example.com", "carl@example.com"]);
  });

  it("replying to our own sent message goes to its recipients", async () => {
    const original = await parse({ from: "max@firma.example", to: "kunde@example.com", subject: "x", text: "y" });
    expect(replyRecipients(original, ["max@firma.example"], false).to.map((m) => m.address)).toEqual(["kunde@example.com"]);
  });
});

describe("replySubject", () => {
  it.each([
    ["Angebot", "Re: Angebot"],
    ["RE: Angebot", "RE: Angebot"],
    ["AW: Angebot", "AW: Angebot"],
    ["Re[2]: Angebot", "Re[2]: Angebot"],
    ["WG: Angebot", "Re: WG: Angebot"],
    ["", "Re: "],
  ])("%s → %s", (input, expected) => {
    expect(replySubject(input)).toBe(expected);
  });
});

describe("quotePlain", () => {
  it("quotes the original with a German attribution line", async () => {
    const original = await parse({
      from: "Anna Muster <anna@example.com>",
      to: "max@firma.example",
      subject: "x",
      text: "Zeile 1\n> alt",
      date: new Date("2026-01-15T10:00:00Z"),
    });
    const quote = quotePlain(original, "de", "UTC");
    const [first, ...rest] = quote.split("\n");
    expect(first).toMatch(/^Am .*2026.* schrieb Anna Muster <anna@example\.com>:$/);
    expect(rest).toEqual(["> Zeile 1", ">> alt"]);
  });

  it("falls back to the HTML body converted to text", async () => {
    const original = await parse({ from: "a@example.com", to: "b@example.com", subject: "x", html: "<p>Hallo <b>Welt</b></p>" });
    expect(quotePlain(original, "en", "UTC")).toContain("> Hallo Welt");
  });
});

describe("replyToMismatch", () => {
  it("reports a Reply-To on an unrelated domain", async () => {
    const original = await parse({ from: "rechnung@lieferant.example", replyTo: "zahlung@lieferant-pay.example", to: "max@firma.example", subject: "x", text: "y" });
    expect(replyToMismatch(original)).toEqual({ replyTo: "zahlung@lieferant-pay.example", from: "rechnung@lieferant.example" });
  });

  it("accepts a Reply-To on a subdomain of the sender's domain", async () => {
    const original = await parse({ from: "news@shop.example", replyTo: "service@mail.shop.example", to: "max@firma.example", subject: "x", text: "y" });
    expect(replyToMismatch(original)).toBeNull();
  });

  it("is null without a Reply-To", async () => {
    const original = await parse({ from: "a@example.com", to: "max@firma.example", subject: "x", text: "y" });
    expect(replyToMismatch(original)).toBeNull();
  });

  it("is null when the Reply-To equals the sender", async () => {
    const original = await parse({ from: "a@example.com", replyTo: "a@example.com", to: "max@firma.example", subject: "x", text: "y" });
    expect(replyToMismatch(original)).toBeNull();
  });
});
