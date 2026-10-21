/**
 * Injection detection patterns, their strength and the risk scoring.
 * All regexes are compiled once at module load for performance.
 */

import type { InjectionType } from "./injection-detector.js";

/** Strong patterns are explicit instructions to an AI; generic ones also occur in ordinary mail. */
export type PatternStrength = "strong" | "generic";

export type ScanLocation = "subject" | "body" | "hidden" | "headers" | "attachment_name" | "address_name";

export interface PatternDef {
  type: InjectionType;
  pattern: RegExp;
  description: string;
  strength: PatternStrength;
  locations: ScanLocation[];
}

/** Confidence reported per finding (kept for result compatibility). */
export const CONFIDENCE: Record<PatternStrength, number> = { strong: 0.9, generic: 0.5 };

// ─── A. Direct Instruction Injection ─────────────────────────────────────────

const INSTRUCTION_PATTERNS: PatternDef[] = [
  // Delimiter + system/admin tags
  {
    type: "system_prompt_override",
    pattern: /\[\s*(SYSTEM|ADMIN|OVERRIDE|INSTRUCTION|ANWEISUNG)\s*\]/i,
    description: "System/admin tag in brackets",
    strength: "generic",
    locations: ["subject", "address_name", "body", "hidden"],
  },
  {
    type: "system_prompt_override",
    pattern: /(?:^|\n)\s*(?:---+|===+|\*\*\*+)\s*(?:SYSTEM|ADMIN|NEW INSTRUCTIONS|NEUE ANWEISUNGEN|SYSTEMANWEISUNG)/im,
    description: "Delimiter followed by system override keyword",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "system_prompt_override",
    pattern: /\b(?:you are now|du bist jetzt|your new role|deine neue rolle)\b/i,
    description: "Role reassignment attempt",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:ignore (?:all )?previous|ignoriere (?:alle )?vorherigen?)\s+(?:instructions?|prompts?|anweisungen?|context)\b/i,
    description: "Ignore previous instructions",
    strength: "strong",
    locations: ["subject", "address_name", "body", "hidden"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:you must now|du musst jetzt|execute the following|führe (?:folgendes|folgenden befehl) aus)\b/i,
    description: "Direct command to AI",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:new instructions|neue anweisungen|updated instructions|aktualisierte anweisungen)\b/i,
    description: "New instructions declaration",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:ignore|bypass|disable|skip)\s+(?:all\s+)?(?:safety|security|content|ethical)\s+(?:guidelines?|rules?|restrictions?|filters?|policies?)\b/i,
    description: "Instruction to bypass safety guidelines",
    strength: "strong",
    locations: ["body", "hidden"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:disregard|discard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|context|rules?|guidelines?)\b/i,
    description: "Disregard/override instructions",
    strength: "strong",
    locations: ["subject", "address_name", "body", "hidden"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:from now on|ab jetzt|ab sofort)\s*,?\s*(?:you|du|the assistant|der assistent)\s+(?:will|must|should|wirst|musst|sollst)\b/i,
    description: "Behavioral override from now on",
    strength: "generic",
    locations: ["body", "hidden"],
  },
];

// ─── E. Structured Data Injection ────────────────────────────────────────────

const STRUCTURED_PATTERNS: PatternDef[] = [
  {
    type: "structured_data_injection",
    pattern: /[{,]\s*"(?:role|system|function_call|tool_use)"\s*:\s*"/i,
    description: "JSON object with role/system/function_call fields",
    strength: "strong",
    locations: ["body", "hidden"],
  },
  {
    type: "structured_data_injection",
    pattern: /<\s*(?:system|instruction|override|prompt|tool_call)\s*>/i,
    description: "XML/HTML tag mimicking system structures",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "structured_data_injection",
    pattern: /^(?:role|system|instruction)\s*:\s*.+/im,
    description: "YAML-like system/role/instruction keys",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "structured_data_injection",
    pattern: /```(?:system|prompt|instructions?)[\s\n]/i,
    description: "Code block labeled as system prompt",
    strength: "generic",
    locations: ["body", "hidden"],
  },
];

// ─── F. Social Engineering / Authority Claims ────────────────────────────────

const SOCIAL_PATTERNS: PatternDef[] = [
  {
    type: "authority_impersonation",
    pattern: /\b(?:authorized|approved|verified|certified)\s+(?:by|from)\s+(?:anthropic|openai)\b/i,
    description: "Fake authorization from AI company",
    strength: "strong",
    locations: ["body", "hidden"],
  },
  {
    type: "authority_impersonation",
    pattern: /\b(?:authorized|approved|verified|certified)\s+(?:by|from)\s+(?:google|microsoft|the (?:system|admin|developer))\b/i,
    description: "Authorization claim by a company or admin",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "authority_impersonation",
    pattern: /\b(?:anthropic|openai)\s+(?:security|support|admin|engineering)\s+team\b/i,
    description: "Impersonation of AI company team",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "authority_impersonation",
    pattern: /\b(?:vorautorisiert|genehmigt durch|autorisiert von|bestätigt durch)\s+(?:die )?(?:IT|administration|system|geschäftsführung)\b/i,
    description: "German fake authorization claim",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "social_engineering",
    pattern: /\b(?:do not|don't|never|nicht)\s+(?:tell|inform|notify|mention|reveal|show|display|informiere|erwähne|zeige)\s+(?:the\s+)?(?:user|human|person|nutzer|benutzer|anwender)\b/i,
    description: "Instruction to hide actions from user",
    strength: "strong",
    locations: ["body", "hidden"],
  },
  {
    type: "social_engineering",
    pattern: /\b(?:silently|secretly|quietly|heimlich|unbemerkt)\s+(?:forward|send|create|draft|execute|weiterleiten|senden|erstellen|ausführen)\b/i,
    description: "Secret action instruction",
    strength: "strong",
    locations: ["body", "hidden"],
  },
  {
    type: "social_engineering",
    pattern: /\b(?:keep this confidential|vertraulich behandeln|do not disclose|nicht weitergeben)\b/i,
    description: "Secrecy instruction",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "social_engineering",
    pattern: /\b(?:immediately|sofort|urgent(?:ly)?|dringend)\s+(?:execute|forward|send|comply|ausführen|weiterleiten|senden)\b/i,
    description: "Urgency combined with action command",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "authority_impersonation",
    pattern: /\b(?:pre-?authorized|admin override|system override|maintenance mode|debug mode)\b/i,
    description: "Fake override/authorization claim",
    strength: "generic",
    locations: ["body", "hidden"],
  },
];

// ─── C. Data Exfiltration ────────────────────────────────────────────────────

const EXFILTRATION_PATTERNS: PatternDef[] = [
  {
    type: "data_exfiltration",
    pattern: /\b(?:forward|send|draft|weiterleiten|senden)\s+(?:all|the|alle|die)?\s*(?:emails?|messages?|data|contents?|passwords?|credentials?|e-?mails?|nachrichten|daten|inhalte|passwörter)\s+(?:to|an)\b/i,
    description: "Instruction to exfiltrate data via email",
    strength: "generic",
    locations: ["body", "hidden"],
  },
  {
    type: "data_exfiltration",
    pattern: /\b(?:create a? ?draft|erstelle? (?:einen? )?entwurf)\s+(?:with|containing|mit|enthält)\s+(?:user|the|alle|all)\s*(?:data|information|emails?|daten|informationen)\b/i,
    description: "Draft creation for data exfiltration",
    strength: "strong",
    locations: ["body", "hidden"],
  },
];

// ─── Compile all patterns into a single array ────────────────────────────────

export const ALL_PATTERNS: PatternDef[] = [
  ...INSTRUCTION_PATTERNS,
  ...STRUCTURED_PATTERNS,
  ...SOCIAL_PATTERNS,
  ...EXFILTRATION_PATTERNS,
];

// ─── Invisible character detection thresholds ────────────────────────────────

/** Zero-width and invisible Unicode characters */
export const INVISIBLE_CHARS_GLOBAL = /[\u200B\u200C\u200D\uFEFF\u2060\u180E]/g;

/**
 * Newsletter preheader padding: invisible characters alternating with spaces ("&#847;&zwnj;&nbsp;" repeated),
 * used to keep body text out of the inbox preview. Carries no hidden text, so it is neither shown nor counted.
 */
export const PREHEADER_PADDING_GLOBAL = /(?:[͏­​‌‍⁠﻿᠎]+\s+){2,}/g;

/** Bidirectional text override characters */
export const BIDI_OVERRIDES_GLOBAL = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Minimum cluster of invisible chars to flag (scattered single chars are common) */
export const INVISIBLE_CLUSTER_MIN = 3;

/** Ratio of invisible to visible chars that triggers a flag */
export const INVISIBLE_RATIO_THRESHOLD = 0.05;

// ─── Encoding evasion patterns ───────────────────────────────────────────────

/** Matches base64-encoded strings (min 20 chars to avoid false positives) */
export const BASE64_BLOCK = /(?:^|[\s:])([A-Za-z0-9+/]{20,}={0,2})(?:$|[\s])/gm;

/** Matches URL-encoded sequences (min 3 consecutive encoded chars) */
export const URL_ENCODED_SEQUENCE = /(?:%[0-9A-Fa-f]{2}){3,}/g;

/** Matches hex-encoded strings */
export const HEX_SEQUENCE = /(?:0x[0-9A-Fa-f]{2}\s*){4,}|(?:\\x[0-9A-Fa-f]{2}){4,}/g;

// ─── Compound scoring ────────────────────────────────────────────────────────

export const RISK_POINTS: Record<PatternStrength, number> = { strong: 3, generic: 1 };

/**
 * Sum of RISK_POINTS over the distinct descriptions (the same phrase twice counts once):
 * 0 none, 1 low, 2 medium, 3-4 high, 5 or more critical.
 */
export function computeRiskLevel(
  findings: Array<{ description: string; strength: PatternStrength }>,
): "none" | "low" | "medium" | "high" | "critical" {
  const byDescription = new Map<string, PatternStrength>();
  for (const f of findings) {
    if (byDescription.get(f.description) !== "strong") byDescription.set(f.description, f.strength);
  }
  let points = 0;
  for (const strength of byDescription.values()) points += RISK_POINTS[strength];
  if (points === 0) return "none";
  if (points === 1) return "low";
  if (points === 2) return "medium";
  if (points <= 4) return "high";
  return "critical";
}
