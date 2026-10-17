import { describe, it, expect } from "vitest";
import { normalizeFlag, uniqueUids } from "../flags.js";

describe("normalizeFlag", () => {
  it.each([
    ["flagged", "\\Flagged"],
    ["\\flagged", "\\Flagged"],
    ["\\Seen", "\\Seen"],
    ["Answered", "\\Answered"],
    ["$Done", "$Done"],
    ["$Erledigt", "$Erledigt"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeFlag(input)).toBe(expected);
  });

  it.each(["\\Recent", "to do", 'say"hi"', "a]b", "back\\slash"])("rejects %s", (input) => {
    expect(() => normalizeFlag(input)).toThrow();
  });

  it("rejects non-ASCII keywords, which imapflow would silently drop from the STORE", () => {
    expect(() => normalizeFlag("$Geprüft")).toThrow(/ASCII/);
    expect(() => normalizeFlag("$✓")).toThrow(/ASCII/);
  });
});

describe("uniqueUids", () => {
  it("removes duplicates and keeps order", () => {
    expect(uniqueUids([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });
});
