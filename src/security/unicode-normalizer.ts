/**
 * Unicode normalization for injection detection.
 * Converts trick Unicode characters to their ASCII equivalents.
 * Used ONLY for detection — never returned to the user.
 */

// ─── Regional Indicator Symbols (U+1F1E6–U+1F1FF) → A-Z ────────────────────
function mapRegionalIndicators(text: string): string {
  return text.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, (ch) => {
    return String.fromCharCode(ch.codePointAt(0)! - 0x1F1E6 + 65);
  });
}

// ─── Enclosed Alphanumeric Supplement ────────────────────────────────────────
// Negative circled (U+1F150–U+1F169) → A-Z
// Negative squared (U+1F170–U+1F189) → A-Z
function mapEnclosedSupplement(text: string): string {
  return text.replace(/[\u{1F150}-\u{1F169}]/gu, (ch) => {
    return String.fromCharCode(ch.codePointAt(0)! - 0x1F150 + 65);
  }).replace(/[\u{1F170}-\u{1F189}]/gu, (ch) => {
    return String.fromCharCode(ch.codePointAt(0)! - 0x1F170 + 65);
  });
}

// ─── Fullwidth characters (U+FF01–U+FF5E) → ASCII (U+0021–U+007E) ───────────
function mapFullwidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) => {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFF01 + 0x21);
  });
}

// ─── Mathematical Alphanumeric Symbols (U+1D400–U+1D7FF) ────────────────────
// Covers bold, italic, script, fraktur, double-struck, monospace etc.
const MATH_ALPHA_RANGES: Array<{ start: number; base: number; len: number }> = [
  // Bold A-Z
  { start: 0x1D400, base: 65, len: 26 },
  // Bold a-z
  { start: 0x1D41A, base: 97, len: 26 },
  // Italic A-Z
  { start: 0x1D434, base: 65, len: 26 },
  // Italic a-z
  { start: 0x1D44E, base: 97, len: 26 },
  // Bold Italic A-Z
  { start: 0x1D468, base: 65, len: 26 },
  // Bold Italic a-z
  { start: 0x1D482, base: 97, len: 26 },
  // Script A-Z
  { start: 0x1D49C, base: 65, len: 26 },
  // Script a-z
  { start: 0x1D4B6, base: 97, len: 26 },
  // Bold Script A-Z
  { start: 0x1D4D0, base: 65, len: 26 },
  // Bold Script a-z
  { start: 0x1D4EA, base: 97, len: 26 },
  // Fraktur A-Z
  { start: 0x1D504, base: 65, len: 26 },
  // Fraktur a-z
  { start: 0x1D51E, base: 97, len: 26 },
  // Double-struck A-Z
  { start: 0x1D538, base: 65, len: 26 },
  // Double-struck a-z
  { start: 0x1D552, base: 97, len: 26 },
  // Bold Fraktur A-Z
  { start: 0x1D56C, base: 65, len: 26 },
  // Bold Fraktur a-z
  { start: 0x1D586, base: 97, len: 26 },
  // Sans-serif A-Z
  { start: 0x1D5A0, base: 65, len: 26 },
  // Sans-serif a-z
  { start: 0x1D5BA, base: 97, len: 26 },
  // Sans-serif Bold A-Z
  { start: 0x1D5D4, base: 65, len: 26 },
  // Sans-serif Bold a-z
  { start: 0x1D5EE, base: 97, len: 26 },
  // Sans-serif Italic A-Z
  { start: 0x1D608, base: 65, len: 26 },
  // Sans-serif Italic a-z
  { start: 0x1D622, base: 97, len: 26 },
  // Sans-serif Bold Italic A-Z
  { start: 0x1D63C, base: 65, len: 26 },
  // Sans-serif Bold Italic a-z
  { start: 0x1D656, base: 97, len: 26 },
  // Monospace A-Z
  { start: 0x1D670, base: 65, len: 26 },
  // Monospace a-z
  { start: 0x1D68A, base: 97, len: 26 },
  // Bold digits 0-9
  { start: 0x1D7CE, base: 48, len: 10 },
  // Double-struck digits 0-9
  { start: 0x1D7D8, base: 48, len: 10 },
  // Sans-serif digits 0-9
  { start: 0x1D7E2, base: 48, len: 10 },
  // Sans-serif Bold digits 0-9
  { start: 0x1D7EC, base: 48, len: 10 },
  // Monospace digits 0-9
  { start: 0x1D7F6, base: 48, len: 10 },
];

// Build a lookup map for O(1) codepoint conversion
const mathAlphaMap = new Map<number, number>();
for (const range of MATH_ALPHA_RANGES) {
  for (let i = 0; i < range.len; i++) {
    mathAlphaMap.set(range.start + i, range.base + i);
  }
}

function mapMathAlpha(text: string): string {
  // Only process if text contains characters in the math range
  if (!/[\u{1D400}-\u{1D7FF}]/u.test(text)) return text;

  const result: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const mapped = mathAlphaMap.get(cp);
    result.push(mapped !== undefined ? String.fromCharCode(mapped) : ch);
  }
  return result.join("");
}

// ─── Superscript / Subscript ─────────────────────────────────────────────────

const SUPERSCRIPT_MAP: Record<string, string> = {
  "\u2070": "0", "\u00B9": "1", "\u00B2": "2", "\u00B3": "3",
  "\u2074": "4", "\u2075": "5", "\u2076": "6", "\u2077": "7",
  "\u2078": "8", "\u2079": "9",
  "\u1D2C": "A", "\u1D2E": "B", "\u1D30": "D", "\u1D31": "E",
  "\u1D33": "G", "\u1D34": "H", "\u1D35": "I", "\u1D36": "J",
  "\u1D37": "K", "\u1D38": "L", "\u1D39": "M", "\u1D3A": "N",
  "\u1D3C": "O", "\u1D3E": "P", "\u1D3F": "R",
  "\u1D40": "T", "\u1D41": "U", "\u1D42": "W",
  "\u1D43": "a", "\u1D47": "b", "\u1D9C": "c", "\u1D48": "d",
  "\u1D49": "e", "\u1DA0": "f", "\u1D4D": "g", "\u02B0": "h",
  "\u2071": "i", "\u02B2": "j", "\u1D4F": "k", "\u02E1": "l",
  "\u1D50": "m", "\u207F": "n", "\u1D52": "o", "\u1D56": "p",
  "\u02B3": "r", "\u02E2": "s", "\u1D57": "t", "\u1D58": "u",
  "\u1D5B": "v", "\u02B7": "w", "\u02E3": "x", "\u02B8": "y",
  "\u1DBB": "z",
};

const SUBSCRIPT_MAP: Record<string, string> = {
  "\u2080": "0", "\u2081": "1", "\u2082": "2", "\u2083": "3",
  "\u2084": "4", "\u2085": "5", "\u2086": "6", "\u2087": "7",
  "\u2088": "8", "\u2089": "9",
  "\u2090": "a", "\u2091": "e", "\u2095": "h", "\u1D62": "i",
  "\u2C7C": "j", "\u2096": "k", "\u2097": "l", "\u2098": "m",
  "\u2099": "n", "\u2092": "o", "\u209A": "p", "\u1D63": "r",
  "\u209B": "s", "\u209C": "t", "\u1D64": "u", "\u1D65": "v",
  "\u2093": "x",
};

function mapSuperSubscript(text: string): string {
  return text.replace(/./gu, (ch) => {
    return SUPERSCRIPT_MAP[ch] || SUBSCRIPT_MAP[ch] || ch;
  });
}

// ─── Circled Letters (Ⓐ-Ⓩ U+24B6-U+24CF, ⓐ-ⓩ U+24D0-U+24E9) ─────────────

function mapCircled(text: string): string {
  return text.replace(/[\u24B6-\u24CF]/g, (ch) => {
    return String.fromCharCode(ch.charCodeAt(0) - 0x24B6 + 65);
  }).replace(/[\u24D0-\u24E9]/g, (ch) => {
    return String.fromCharCode(ch.charCodeAt(0) - 0x24D0 + 97);
  });
}

// ─── Small Caps (common mappings) ────────────────────────────────────────────

const SMALL_CAPS_MAP: Record<string, string> = {
  "\u1D00": "A", "\u0299": "B", "\u1D04": "C", "\u1D05": "D",
  "\u1D07": "E", "\uA730": "F", "\u0262": "G", "\u029C": "H",
  "\u026A": "I", "\u1D0A": "J", "\u1D0B": "K", "\u029F": "L",
  "\u1D0D": "M", "\u0274": "N", "\u1D0F": "O", "\u1D18": "P",
  // No standard small cap Q
  "\u0280": "R", "\uA731": "S", "\u1D1B": "T", "\u1D1C": "U",
  "\u1D20": "V", "\u1D21": "W",
  // No standard small cap X
  "\u028F": "Y", "\u1D22": "Z",
};

function mapSmallCaps(text: string): string {
  return text.replace(/./gu, (ch) => SMALL_CAPS_MAP[ch] || ch);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/** Quick check: does the text contain any non-ASCII that needs normalization? */
export function hasNonAscii(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

/**
 * Normalize Unicode trick characters to ASCII equivalents.
 * Order matters: NFKD first, then specific mappings, then strip combining marks.
 */
export function normalizeToASCII(text: string): string {
  if (!hasNonAscii(text)) return text;

  // Step 1: NFKD normalization (decomposes ligatures, compatibility chars)
  let result = text.normalize("NFKD");

  // Step 2: Apply specific character mappings
  result = mapRegionalIndicators(result);
  result = mapEnclosedSupplement(result);
  result = mapFullwidth(result);
  result = mapMathAlpha(result);
  result = mapSuperSubscript(result);
  result = mapCircled(result);
  result = mapSmallCaps(result);

  // Step 3: Strip combining diacritical marks (after NFKD decomposition)
  result = result.replace(/[\u0300-\u036F]/g, "");

  return result;
}
