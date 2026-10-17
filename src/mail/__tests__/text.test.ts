import { describe, it, expect } from "vitest";
import { boundedText, fullText, stripQuotedHistory, truncate } from "../text.js";

describe("boundedText", () => {
  const text = "0123456789".repeat(5); // 50 chars

  it("returns the first window with paging info", () => {
    expect(boundedText({ text }, { maxChars: 20, offset: 0 })).toEqual({
      text: text.slice(0, 20),
      totalChars: 50,
      offset: 0,
      truncated: true,
      nextOffset: 20,
    });
  });

  it("returns the last window without nextOffset", () => {
    const res = boundedText({ text }, { maxChars: 20, offset: 40 });
    expect(res).toEqual({ text: text.slice(40), totalChars: 50, offset: 40, truncated: false });
  });

  it("clamps an offset beyond the end", () => {
    expect(boundedText({ text }, { maxChars: 20, offset: 999 })).toMatchObject({ text: "", offset: 50, truncated: false });
  });

  it("never splits an emoji (surrogate pair) at the window boundary", () => {
    const withEmoji = "abc😀def"; // "😀" occupies indices 3 and 4
    const first = boundedText({ text: withEmoji }, { maxChars: 4, offset: 0 });
    expect(first.text).toBe("abc");
    expect(first.nextOffset).toBe(3);
    const second = boundedText({ text: withEmoji }, { maxChars: 4, offset: first.nextOffset! });
    expect(second.text).toBe("😀de");
  });

  it("generates text from HTML and says so", () => {
    expect(boundedText({ html: "<p>Hallo <b>Welt</b></p>" }, { maxChars: 100, offset: 0 })).toMatchObject({
      text: "Hallo Welt",
      textGenerated: true,
    });
  });
});

describe("fullText", () => {
  it("returns an empty string for messages without a body", () => {
    expect(fullText({})).toEqual({ text: "", generated: false });
  });
});

describe("truncate", () => {
  it("adds an ellipsis only when needed", () => {
    expect(truncate("kurz", 10)).toEqual({ text: "kurz", truncated: false });
    expect(truncate("ein langer Satz", 8)).toEqual({ text: "ein lan…", truncated: true });
  });
});

describe("stripQuotedHistory", () => {
  it("cuts at an English attribution line", () => {
    expect(stripQuotedHistory("Thanks!\n\nOn 15 Jan 2026, 10:00, Anna <a@x.com> wrote:\n> old")).toEqual({
      text: "Thanks!",
      stripped: true,
    });
  });

  it("cuts at a German attribution line", () => {
    expect(stripQuotedHistory("Passt.\r\nAm 15.01.2026 um 10:00 schrieb Anna Muster <a@x.com>:\r\n> alt").text).toBe("Passt.");
  });

  it("cuts at an Outlook header block", () => {
    const text = "Erledigt.\n\nVon: Anna Muster <a@x.com>\nGesendet: Donnerstag, 15. Jänner 2026 10:00\nAn: Max\nBetreff: Angebot\n\nalter Text";
    expect(stripQuotedHistory(text).text).toBe("Erledigt.");
  });

  it("keeps a normal line that merely starts with From:", () => {
    expect(stripQuotedHistory("From: our side, all good.\nBye").text).toBe("From: our side, all good.\nBye");
  });

  it("drops interleaved > lines", () => {
    expect(stripQuotedHistory("> question?\nanswer").text).toBe("answer");
  });
});
