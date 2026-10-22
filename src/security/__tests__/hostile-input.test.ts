import { describe, it, expect } from "vitest";
import { scanForInjection } from "../injection-detector.js";
import { PREHEADER_PADDING_GLOBAL } from "../patterns.js";

const BUDGET_MS = 500;
const RUN = 64 * 1024;

function ms(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("scanner on hostile input", () => {
  it.each([
    ["an exfiltration verb", `send${" ".repeat(RUN)}x`],
    ["'from now on'", `from now on${" ".repeat(RUN)}x`],
    ["blank lines before a delimiter", `${"\n".repeat(RUN)}x`],
    ["carriage returns", `${"\r".repeat(RUN)}x`],
    ["invisible characters without whitespace", `${"\u{034F}".repeat(RUN)}x`],
  ])("a 64k run after %s", (_name, body) => {
    expect(ms(() => scanForInjection({ body, hidden: body }))).toBeLessThan(BUDGET_MS);
  });

  it("matches preheader padding in linear time and as before on normal input", () => {
    expect(ms(() => `${"\u{200C}".repeat(RUN)}x`.replace(PREHEADER_PADDING_GLOBAL, " "))).toBeLessThan(BUDGET_MS);
    expect(`a${"\u{034F}\u{200C}\u{00A0}".repeat(3)}b`.replace(PREHEADER_PADDING_GLOBAL, "|")).toBe("a|b");
    expect(`a \u{034F} b`.replace(PREHEADER_PADDING_GLOBAL, "|")).toBe(`a \u{034F} b`);
  });
});
