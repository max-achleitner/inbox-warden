import { describe, it, expect } from "vitest";
import { stripInvisible, visibleHtml } from "../visible-text.js";
import { fullText } from "../text.js";

/** Generous budget: these inputs took seconds to minutes before the regexes and the rule matching were made linear. */
const BUDGET_MS = 500;

function timed<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

const DIGITS = "9".repeat(64 * 1024);
const SPACES = " ".repeat(64 * 1024);

/** A newsletter of about `bytes` characters: a style sheet, a hidden preheader, product cards in nested tables. */
function newsletter(bytes: number): string {
  const css =
    Array.from({ length: 300 }, (_, i) => `.c${i}{color:#333333;font-size:14px;line-height:20px;padding:0 ${i % 20}px}`).join("\n") +
    "\n@media only screen and (max-width:600px){.col{width:100%!important;display:block!important}}";
  const card = (i: number) =>
    `<tr><td class="c${i % 300}" style="padding:16px;background-color:#ffffff;font-family:Arial,sans-serif">` +
    `<table role="presentation" width="100%"><tr><td style="font-size:0">` +
    `<div class="col" style="display:inline-block;width:50%;font-size:14px;color:#222222">Produkt ${i}: ein Angebot nur diese Woche ` +
    `<a href="https://shop.example.com/p/${i}?utm_source=newsletter" style="color:#0055ff">Jetzt ansehen</a></div>` +
    `<div class="col" style="display:inline-block;width:50%;font-size:14px"><img src="https://img.example.com/${i}.jpg" alt="Produkt ${i}" width="280"></div>` +
    `</td></tr></table></td></tr>`;
  const cards: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const c = card(i);
    cards.push(c);
    size += c.length;
  }
  return (
    `<!doctype html><html><head><style>${css}</style></head><body style="margin:0;background:#f4f4f4">` +
    `<div style="display:none;max-height:0;overflow:hidden">Vorschau${"&#847;&zwnj;&nbsp;".repeat(80)}</div>` +
    `<table width="100%" bgcolor="#f4f4f4">${cards.join("")}</table></body></html>`
  );
}

describe("hostile input stays cheap", () => {
  it.each([
    ["font-size", `<p style="font-size:${DIGITS}q">sichtbar</p>`],
    ["height", `<div style="height:${DIGITS}q;overflow:hidden">sichtbar</div>`],
    ["text-indent", `<p style="text-indent:${DIGITS}q">sichtbar</p>`],
    ["left", `<div style="position:absolute;left:${DIGITS}q">sichtbar</div>`],
    ["opacity", `<div style="opacity:${DIGITS}q">sichtbar</div>`],
  ])("a 64 KB digit run in %s", (_name, html) => {
    const { result, ms } = timed(() => fullText({ html }));
    expect(result.text).toContain("sichtbar");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("a 64 KB digit run in a style rule applied to many elements", () => {
    const html = `<style>.a{font-size:${"9".repeat(60_000)}q}</style>${'<p class="a">x</p>'.repeat(5_000)}`;
    const { ms } = timed(() => visibleHtml(html));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ["before !important", `<div style="display:block${SPACES}!important">sichtbar</div>`],
    ["without !important", `<div style="color:a${SPACES}b">sichtbar</div>`],
  ])("64 KB of whitespace %s", (_name, html) => {
    const { result, ms } = timed(() => fullText({ html }));
    expect(result.text).toContain("sichtbar");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("5,000 rules for one class times 5,000 elements", () => {
    const html = `<style>${".a{color:#000}".repeat(5_000)}</style>${'<p class="a">x</p>'.repeat(5_000)}`;
    const { ms } = timed(() => visibleHtml(html));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("4,000 rules for one class (under the style cap) times 20,000 elements with distinct classes", () => {
    const html = `<style>${".a{color:#000}".repeat(4_000)}</style>${Array.from({ length: 20_000 }, (_, i) => `<p class="a b${i}">x</p>`).join("")}`;
    const { result, ms } = timed(() => visibleHtml(html));
    expect(result.removed).toBeUndefined();
    expect(ms).toBeLessThan(BUDGET_MS * 2);
  });

  it.each([
    ["combining grapheme joiners", "\u{034F}".repeat(64 * 1024) + "x"],
    ["zero-width spaces", "\u{200B}".repeat(64 * 1024)],
    ["zero-width joiners", "\u{200D}".repeat(64 * 1024)],
    ["byte order marks", "\u{FEFF}".repeat(64 * 1024) + "x"],
  ])("a 64k run of %s without whitespace through stripInvisible", (_name, text) => {
    const { ms } = timed(() => stripInvisible(text));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("a 1 MB newsletter", () => {
    const html = newsletter(1024 * 1024);
    expect(html.length).toBeGreaterThan(1024 * 1024);
    const { result, ms } = timed(() => fullText({ html }));
    expect(result.text).toContain("Produkt 0: ein Angebot nur diese Woche");
    expect(result.text).toContain("Jetzt ansehen");
    expect(result.text).not.toContain("Vorschau");
    expect(result.hidden).toEqual({ chars: 8, kinds: ["display-none"] });
    expect(ms).toBeLessThan(5_000);
  });
});
