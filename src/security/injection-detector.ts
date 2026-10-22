/**
 * Prompt injection detection for email content.
 * Scans email fields and returns metadata — never modifies the original content.
 */

import { normalizeToASCII, hasNonAscii } from "./unicode-normalizer.js";
import {
  ALL_PATTERNS,
  INVISIBLE_CHARS_GLOBAL,
  BIDI_OVERRIDES_GLOBAL,
  INVISIBLE_CLUSTER_MIN,
  INVISIBLE_RATIO_THRESHOLD,
  PREHEADER_PADDING_GLOBAL,
  BASE64_BLOCK,
  URL_ENCODED_SEQUENCE,
  HEX_SEQUENCE,
  CONFIDENCE,
  INTERLEAVED,
  VIA_NORMALIZATION,
  computeRiskLevel,
  type PatternStrength,
  type ScanLocation,
} from "./patterns.js";

export type { PatternStrength, ScanLocation } from "./patterns.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type InjectionType =
  | "system_prompt_override"
  | "instruction_injection"
  | "data_exfiltration"
  | "authority_impersonation"
  | "unicode_obfuscation"
  | "invisible_text"
  | "structured_data_injection"
  | "social_engineering"
  | "encoding_evasion"
  | "multi_vector";

export interface InjectionFinding {
  type: InjectionType;
  description: string;
  location: ScanLocation;
  snippet: string;
  /** 0.9 strong, 0.5 generic (kept for result compatibility). */
  confidence: number;
  strength: PatternStrength;
}

export interface InjectionScanResult {
  hasInjection: boolean;
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
  findings: InjectionFinding[];
  sanitizedPreview?: string;
}

// ─── Snippet extraction ──────────────────────────────────────────────────────

function makeSnippet(text: string, match: RegExpMatchArray | RegExpExecArray): string {
  const start = Math.max(0, (match.index ?? 0) - 20);
  const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 20);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  return snippet.slice(0, 200);
}

// ─── Pattern scanning (categories A, D, E, F, exfiltration) ──────────────────

function scanPatterns(
  text: string,
  location: ScanLocation,
  findings: InjectionFinding[],
): void {
  // Filter patterns applicable to this location
  const applicable = ALL_PATTERNS.filter((p) => p.locations.includes(location));

  for (const pat of applicable) {
    const match = pat.pattern.exec(text);
    if (match) {
      findings.push({
        type: pat.type,
        description: pat.description,
        location,
        snippet: makeSnippet(text, match),
        confidence: CONFIDENCE[pat.strength],
        strength: pat.strength,
      });
    }
    // Reset lastIndex for non-global patterns used with exec
    pat.pattern.lastIndex = 0;
  }

  // Also scan normalized text if it contains non-ASCII
  if (hasNonAscii(text)) {
    const normalized = normalizeToASCII(text);
    if (normalized !== text) {
      // Check if normalization revealed hidden injection patterns
      let foundViaUnicode = false;
      let viaStrong = false;
      for (const pat of applicable) {
        // Only re-check if the original didn't match
        const originalMatch = pat.pattern.test(text);
        pat.pattern.lastIndex = 0;
        const normalizedMatch = pat.pattern.exec(normalized);
        pat.pattern.lastIndex = 0;

        if (!originalMatch && normalizedMatch) {
          foundViaUnicode = true;
          if (pat.strength === "strong") viaStrong = true;
          findings.push({
            type: pat.type,
            description: `${pat.description}${VIA_NORMALIZATION}`,
            location,
            snippet: makeSnippet(normalized, normalizedMatch),
            confidence: CONFIDENCE[pat.strength],
            strength: pat.strength,
          });
        }
      }

      if (foundViaUnicode) {
        findings.push({
          type: "unicode_obfuscation",
          description: "Text uses Unicode trick characters to obfuscate injection patterns",
          location,
          snippet: text.slice(0, 200),
          confidence: CONFIDENCE[viaStrong ? "strong" : "generic"],
          strength: viaStrong ? "strong" : "generic",
        });
      }
    }
  }
}

// ─── Category B: Unicode obfuscation detection ──────────────────────────────

// Letter-like trick characters only: mathematical alphanumerics, negative circled/squared and circled letters,
// superscript/subscript letters, and fullwidth Latin letters and digits. Flags (regional indicators), other emoji,
// superscript digits and fullwidth punctuation occur in ordinary mail and do not count; neither does a letter shown as
// an emoji (followed by U+FE0F, such as the parking sign).
const TRICK_LETTERS =
  "\u{1D400}-\u{1D7FF}\u{1F150}-\u{1F189}\u{24B6}-\u{24E9}" +
  "\u{1D2C}-\u{1D5B}\u{1D62}-\u{1D65}\u{1D9C}\u{1DA0}\u{1DBB}\u{2071}\u{207F}\u{2090}-\u{209C}\u{02B0}\u{02B2}\u{02B3}\u{02B7}\u{02B8}\u{02E1}-\u{02E3}";
const FULLWIDTH_ALNUM = "\u{FF10}-\u{FF19}\u{FF21}-\u{FF3A}\u{FF41}-\u{FF5A}";
const TRICK = new RegExp(`[${TRICK_LETTERS}](?!\u{FE0F})`, "gu");
const TRICK_OR_FULLWIDTH = new RegExp(`[${TRICK_LETTERS}${FULLWIDTH_ALNUM}](?!\u{FE0F})`, "gu");
/** In Chinese, Japanese and Korean text fullwidth letters and digits are ordinary typography. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Groups of consecutive words that contain trick characters (a word with one trick character counts whole). */
function trickRuns(text: string, trick: RegExp): string[] {
  const runs: string[] = [];
  let current: string[] = [];
  for (const word of text.split(/\s+/)) {
    trick.lastIndex = 0;
    if (word && trick.test(word)) current.push(word);
    else if (current.length > 0) {
      runs.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) runs.push(current.join(" "));
  trick.lastIndex = 0;
  return runs;
}

function scanUnicodeObfuscation(
  text: string,
  location: ScanLocation,
  findings: InjectionFinding[],
): void {
  if (!hasNonAscii(text)) return;

  const trick = CJK.test(text) ? TRICK : TRICK_OR_FULLWIDTH;
  const trickCharCount = text.match(trick)?.length ?? 0;

  // Only flag if there's a meaningful cluster (>= 4 trick chars)
  if (trickCharCount >= 4) {
    // Strong only when the trick-character words, once normalised, spell an instruction keyword
    const strong = trickRuns(text, trick).some((run) => DECODED_INJECTION_KEYWORDS.test(normalizeToASCII(run)));
    const strength: PatternStrength = strong ? "strong" : "generic";
    findings.push({
      type: "unicode_obfuscation",
      description: `${trickCharCount} Unicode trick characters detected (mathematical, enclosed, circled, superscript or fullwidth letters)`,
      location,
      snippet: text.slice(0, 200),
      confidence: CONFIDENCE[strength],
      strength,
    });
  }
}

// ─── Category C: Invisible text detection ────────────────────────────────────

function scanInvisibleText(
  text: string,
  location: ScanLocation,
  findings: InjectionFinding[],
): void {
  // Check for zero-width character clusters (preheader padding of newsletters does not count)
  const scanned = text.replace(PREHEADER_PADDING_GLOBAL, " ");
  const invisibleMatches = scanned.match(INVISIBLE_CHARS_GLOBAL);
  if (invisibleMatches && invisibleMatches.length >= INVISIBLE_CLUSTER_MIN) {
    // Check ratio
    const visibleLen = scanned.replace(INVISIBLE_CHARS_GLOBAL, "").replace(BIDI_OVERRIDES_GLOBAL, "").length;
    const ratio = visibleLen > 0 ? invisibleMatches.length / visibleLen : 1;

    if (ratio >= INVISIBLE_RATIO_THRESHOLD || invisibleMatches.length >= 5) {
      // Check if invisible chars appear within/around visible text (not just at boundaries)
      const interleaved = /\S[\u200B\u200C\u200D\uFEFF\u2060\u180E]+\S/.test(scanned);
      findings.push({
        type: "invisible_text",
        description: `${invisibleMatches.length} zero-width characters detected${interleaved ? INTERLEAVED : ""}`,
        location,
        snippet: text.slice(0, 200),
        confidence: CONFIDENCE[interleaved ? "strong" : "generic"],
        strength: interleaved ? "strong" : "generic",
      });
    }
  }

  // Check for bidi overrides
  const bidiMatches = text.match(BIDI_OVERRIDES_GLOBAL);
  if (bidiMatches && bidiMatches.length >= 2) {
    findings.push({
      type: "invisible_text",
      description: `${bidiMatches.length} bidirectional text override characters detected`,
      location,
      snippet: text.slice(0, 200),
      confidence: CONFIDENCE.generic,
      strength: "generic",
    });
  }
}

// ─── Category G: Encoding evasion detection ──────────────────────────────────

// Instruction-like keywords to check in decoded content
// Whole words only: "Kassensystem" or "administration" are no instruction
const DECODED_INJECTION_KEYWORDS = /\b(?:ignore|ignoriere|system|override|instructions?|execute|forward|send all|admin|anweisung(?:en)?)\b/i;

function scanEncodingEvasion(
  text: string,
  location: ScanLocation,
  findings: InjectionFinding[],
): void {
  // Base64 detection
  BASE64_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BASE64_BLOCK.exec(text)) !== null) {
    const candidate = match[1];
    try {
      const decoded = Buffer.from(candidate, "base64").toString("utf-8");
      // Only flag if decoded content looks like injection AND is valid text
      if (DECODED_INJECTION_KEYWORDS.test(decoded) && /^[\x20-\x7E\s]+$/.test(decoded)) {
        findings.push({
          type: "encoding_evasion",
          description: "Base64-encoded string decodes to instruction-like text",
          location,
          snippet: `Encoded: ${candidate.slice(0, 40)}... → Decoded: ${decoded.slice(0, 100)}`,
          confidence: CONFIDENCE.generic,
          strength: "generic",
        });
        break; // One finding is enough
      }
    } catch {
      // Not valid base64, skip
    }
  }

  // URL-encoded detection
  URL_ENCODED_SEQUENCE.lastIndex = 0;
  while ((match = URL_ENCODED_SEQUENCE.exec(text)) !== null) {
    try {
      const decoded = decodeURIComponent(match[0]);
      if (DECODED_INJECTION_KEYWORDS.test(decoded)) {
        findings.push({
          type: "encoding_evasion",
          description: "URL-encoded string decodes to instruction-like text",
          location,
          snippet: `Encoded: ${match[0].slice(0, 60)} → Decoded: ${decoded.slice(0, 100)}`,
          confidence: CONFIDENCE.generic,
          strength: "generic",
        });
        break;
      }
    } catch {
      // Invalid encoding
    }
  }

  // Hex-encoded detection
  HEX_SEQUENCE.lastIndex = 0;
  while ((match = HEX_SEQUENCE.exec(text)) !== null) {
    try {
      const hexStr = match[0].replace(/0x|\\x/g, "");
      const bytes = hexStr.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
      const decoded = String.fromCharCode(...bytes);
      if (DECODED_INJECTION_KEYWORDS.test(decoded) && /^[\x20-\x7E\s]+$/.test(decoded)) {
        findings.push({
          type: "encoding_evasion",
          description: "Hex-encoded string decodes to instruction-like text",
          location,
          snippet: `Encoded: ${match[0].slice(0, 60)} → Decoded: ${decoded.slice(0, 100)}`,
          confidence: CONFIDENCE.generic,
          strength: "generic",
        });
        break;
      }
    } catch {
      // Invalid hex
    }
  }
}

/** Findings in hidden text never quote it. */
const HIDDEN_SNIPPET = "(hidden text — not shown)";

// ─── Main scan function ──────────────────────────────────────────────────────

export interface ScanInput {
  subject?: string;
  body?: string;
  /** Text the reader cannot see (hidden HTML, comments, invisible characters); scanning only, never shown. */
  hidden?: string;
  headers?: string;
  attachmentNames?: string[];
  /** Display names of From, Reply-To, To and Cc, which the tools show next to the addresses. */
  addressNames?: string[];
}

let totalScans = 0;
let totalDetections = 0;

/** How many scans ran and how many found something, since this process started (shown by health_check). */
export function scanStats(): { totalScans: number; totalDetections: number } {
  return { totalScans, totalDetections };
}

/**
 * Scan email content for prompt injection attempts.
 * Returns metadata with findings — never modifies the original content.
 */
export function scanForInjection(input: ScanInput): InjectionScanResult {
  const findings: InjectionFinding[] = [];

  const fields: Array<{ text: string; location: ScanLocation }> = [];

  if (input.subject) fields.push({ text: input.subject, location: "subject" });
  if (input.body) fields.push({ text: input.body, location: "body" });
  if (input.hidden) fields.push({ text: input.hidden, location: "hidden" });
  if (input.headers) fields.push({ text: input.headers, location: "headers" });
  if (input.attachmentNames) {
    for (const name of input.attachmentNames) {
      fields.push({ text: name, location: "attachment_name" });
    }
  }
  for (const name of input.addressNames ?? []) {
    if (name) fields.push({ text: name, location: "address_name" });
  }

  for (const { text, location } of fields) {
    // Run all detection categories
    scanPatterns(text, location, findings);
    scanUnicodeObfuscation(text, location, findings);
    scanInvisibleText(text, location, findings);
    scanEncodingEvasion(text, location, findings);

    // Hidden text is scanning-only: a finding never quotes it
    if (location === "hidden") {
      for (const f of findings) if (f.location === "hidden") f.snippet = HIDDEN_SNIPPET;
    }

    // Early exit: if we already have a critical finding, skip remaining fields
    const currentLevel = computeRiskLevel(findings);
    if (currentLevel === "critical") break;
  }

  // Check for multi-vector attacks
  const uniqueTypes = new Set(findings.map((f) => f.type));
  if (uniqueTypes.size >= 3) {
    findings.push({
      type: "multi_vector",
      description: `Combined attack using ${uniqueTypes.size} different techniques`,
      location: "body",
      snippet: `Techniques: ${[...uniqueTypes].join(", ")}`,
      confidence: CONFIDENCE.generic,
      strength: "generic",
    });
  }

  const riskLevel = computeRiskLevel(findings);
  const hasInjection = findings.length > 0;
  totalScans++;
  if (hasInjection) totalDetections++;

  let sanitizedPreview: string | undefined;
  if (hasInjection) {
    const typeCounts = new Map<string, number>();
    for (const f of findings) {
      typeCounts.set(f.type, (typeCounts.get(f.type) ?? 0) + 1);
    }
    const descriptions = [...typeCounts.entries()]
      .map(([type, count]) => {
        const label = type.replace(/_/g, " ");
        return count > 1 ? `${label} (${count}x)` : label;
      })
      .join(", ");
    // D13: only high and critical are called an injection; lower levels are weak hints
    sanitizedPreview =
      riskLevel === "high" || riskLevel === "critical"
        ? `⚠️ This email contains ${findings.length} prompt injection indicator(s): ${descriptions}`
        : `Weak hint (risk ${riskLevel}): ${findings.length} pattern(s) that also occur in ordinary mail (${descriptions}); not a sign of manipulation on its own.`;
  }

  return { hasInjection, riskLevel, findings, sanitizedPreview };
}

/**
 * Lightweight scan for search results — only checks subject.
 */
export function scanSubjectOnly(subject: string): InjectionScanResult {
  return scanForInjection({ subject });
}
