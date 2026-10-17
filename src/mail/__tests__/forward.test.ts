import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { emlFilename, forwardHeaderBlock, forwardInlineText, forwardSubject } from "../forward.js";

describe("forwardSubject", () => {
  it.each([
    ["Angebot", "de", "WG: Angebot"],
    ["Angebot", "en", "Fwd: Angebot"],
    ["WG: Angebot", "en", "WG: Angebot"],
    ["FW: Angebot", "de", "FW: Angebot"],
    ["AW: Angebot", "de", "WG: AW: Angebot"],
  ] as const)("%s (%s) → %s", (input, language, expected) => {
    expect(forwardSubject(input, language)).toBe(expected);
  });
});

describe("forward body", () => {
  it("builds a German header block and the original text", async () => {
    const original = await simpleParser(
      await buildRaw({
        from: "Anna Muster <anna@example.com>",
        to: "max@firma.example",
        cc: "bob@example.com",
        subject: "Lieferung",
        text: "Die Ware kommt Montag.",
        date: new Date("2026-01-15T10:00:00Z"),
      }),
    );
    const block = forwardHeaderBlock(original, "de", "UTC").split("\n");
    expect(block[0]).toBe("---------- Weitergeleitete Nachricht ----------");
    expect(block[1]).toBe("Von: Anna Muster <anna@example.com>");
    expect(block[2]).toMatch(/^Datum: .*2026/);
    expect(block.slice(3)).toEqual(["Betreff: Lieferung", "An: max@firma.example", "Cc: bob@example.com"]);
    expect(forwardInlineText(original, "de", "UTC").endsWith("\n\nDie Ware kommt Montag.")).toBe(true);
  });
});

describe("emlFilename", () => {
  it("sanitises the subject", () => {
    expect(emlFilename('Re: "Angebot" 1/2')).toBe("Re_ _Angebot_ 1_2.eml");
    expect(emlFilename(undefined)).toBe("message.eml");
  });
});
