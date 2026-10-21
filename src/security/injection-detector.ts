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
            description: `${pat.description} (detected via unicode normalization)`,
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

function scanUnicodeObfuscation(
  text: string,
  location: ScanLocation,
  findings: InjectionFinding[],
): void {
  if (!hasNonAscii(text)) return;

  // Check for high concentration of unusual Unicode blocks
  const mathAlpha = text.match(/[\u{1D400}-\u{1D7FF}]/gu);
  const enclosed = text.match(/[\u{1F150}-\u{1F189}]/gu);
  const regional = text.match(/[\u{1F1E6}-\u{1F1FF}]/gu);
  const fullwidth = text.match(/[\uFF01-\uFF5E]/g);
  const circled = text.match(/[\u24B6-\u24E9]/g);
  // Superscript/subscript chars used for letter substitution
  const superSub = text.match(/[\u1D2C-\u1D42\u1D43-\u1D5B\u1D62-\u1D65\u1D9C\u1DA0\u1DBB\u2070-\u209C\u02B0\u02B2\u02B3\u02B7\u02B8\u02E1-\u02E3]/g);

  const trickCharCount =
    (mathAlpha?.length ?? 0) +
    (enclosed?.length ?? 0) +
    (regional?.length ?? 0) +
    (fullwidth?.length ?? 0) +
    (circled?.length ?? 0) +
    (superSub?.length ?? 0);

  // Only flag if there's a meaningful cluster (>= 4 trick chars)
  if (trickCharCount >= 4) {
    // Strong only when the letters, once normalised, spell something instruction-like
    const strength: PatternStrength = DECODED_INJECTION_KEYWORDS.test(normalizeToASCII(text)) ? "strong" : "generic";
    findings.push({
      type: "unicode_obfuscation",
      description: `${trickCharCount} Unicode trick characters detected (mathematical, enclosed, regional indicator, fullwidth, or circled)`,
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
        description: `${invisibleMatches.length} zero-width characters detected${interleaved ? " interleaved with visible text" : ""}`,
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
const DECODED_INJECTION_KEYWORDS = /(?:ignore|system|override|instruction|execute|forward|send all|admin|anweisung|ignoriere)/i;

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
    sanitizedPreview = `⚠️ This email contains ${findings.length} prompt injection indicator(s): ${descriptions}`;
  }

  return { hasInjection, riskLevel, findings, sanitizedPreview };
}

/**
 * Lightweight scan for search results — only checks subject.
 */
export function scanSubjectOnly(subject: string): InjectionScanResult {
  return scanForInjection({ subject });
}
