/**
 * Injection detection patterns and confidence scores.
 * All regexes are compiled once at module load for performance.
 */

import type { InjectionType } from "./injection-detector.js";

export interface PatternDef {
  type: InjectionType;
  pattern: RegExp;
  description: string;
  confidence: number;
  locations: Array<"subject" | "body" | "html" | "headers" | "attachment_name">;
}

// ─── A. Direct Instruction Injection ─────────────────────────────────────────

const INSTRUCTION_PATTERNS: PatternDef[] = [
  // Delimiter + system/admin tags
  {
    type: "system_prompt_override",
    pattern: /\[\s*(SYSTEM|ADMIN|OVERRIDE|INSTRUCTION|ANWEISUNG)\s*\]/i,
    description: "System/admin tag in brackets",
    confidence: 0.7,
    locations: ["subject", "body", "html"],
  },
  {
    type: "system_prompt_override",
    pattern: /(?:^|\n)\s*(?:---+|===+|\*\*\*+)\s*(?:SYSTEM|ADMIN|NEW INSTRUCTIONS|NEUE ANWEISUNGEN|SYSTEMANWEISUNG)/im,
    description: "Delimiter followed by system override keyword",
    confidence: 0.85,
    locations: ["body", "html"],
  },
  {
    type: "system_prompt_override",
    pattern: /\b(?:you are now|du bist jetzt|your new role|deine neue rolle)\b/i,
    description: "Role reassignment attempt",
    confidence: 0.8,
    locations: ["body", "html"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:ignore (?:all )?previous|ignoriere (?:alle )?vorherigen?)\s+(?:instructions?|prompts?|anweisungen?|context)\b/i,
    description: "Ignore previous instructions",
    confidence: 0.9,
    locations: ["subject", "body", "html"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:you must now|du musst jetzt|execute the following|führe (?:folgendes|folgenden befehl) aus)\b/i,
    description: "Direct command to AI",
    confidence: 0.8,
    locations: ["body", "html"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:new instructions|neue anweisungen|updated instructions|aktualisierte anweisungen)\b/i,
    description: "New instructions declaration",
    confidence: 0.85,
    locations: ["body", "html"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:ignore|bypass|disable|skip)\s+(?:all\s+)?(?:safety|security|content|ethical)\s+(?:guidelines?|rules?|restrictions?|filters?|policies?)\b/i,
    description: "Instruction to bypass safety guidelines",
    confidence: 0.9,
    locations: ["body", "html"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:disregard|discard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|context|rules?|guidelines?)\b/i,
    description: "Disregard/override instructions",
    confidence: 0.9,
    locations: ["subject", "body", "html"],
  },
  {
    type: "instruction_injection",
    pattern: /\b(?:from now on|ab jetzt|ab sofort)\s*,?\s*(?:you|du|the assistant|der assistent)\s+(?:will|must|should|wirst|musst|sollst)\b/i,
    description: "Behavioral override from now on",
    confidence: 0.85,
    locations: ["body", "html"],
  },
];

// ─── D. HTML/Comment Injection ───────────────────────────────────────────────

const HTML_PATTERNS: PatternDef[] = [
  {
    type: "html_comment_injection",
    pattern: /<!--[\s\S]*?(?:instruction|ignore|system|override|anweisung|prompt|assistant|you must|du musst)[\s\S]*?-->/i,
    description: "HTML comment containing instruction-like text",
    confidence: 0.85,
    locations: ["html"],
  },
  {
    type: "html_comment_injection",
    pattern: /<[^>]+(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|height\s*:\s*0[^0-9]|width\s*:\s*0[^0-9]|position\s*:\s*absolute[^>]*left\s*:\s*-\d{3,})/i,
    description: "Hidden HTML element with CSS concealment",
    confidence: 0.75,
    locations: ["html"],
  },
  {
    type: "html_comment_injection",
    pattern: /<[^>]+(?:color\s*:\s*(?:white|#fff(?:fff)?|transparent|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)))/i,
    description: "Text with invisible color styling",
    confidence: 0.7,
    locations: ["html"],
  },
  {
    type: "html_comment_injection",
    pattern: /<script[\s>]/i,
    description: "Script tag in email HTML",
    confidence: 0.8,
    locations: ["html"],
  },
  {
    type: "html_comment_injection",
    pattern: /\bdata-instruction\s*=/i,
    description: "Data attribute with instruction payload",
    confidence: 0.85,
    locations: ["html"],
  },
];

// ─── E. Structured Data Injection ────────────────────────────────────────────

const STRUCTURED_PATTERNS: PatternDef[] = [
  {
    type: "structured_data_injection",
    pattern: /[{,]\s*"(?:role|system|function_call|tool_use)"\s*:\s*"/i,
    description: "JSON object with role/system/function_call fields",
    confidence: 0.8,
    locations: ["body", "html"],
  },
  {
    type: "structured_data_injection",
    pattern: /<\s*(?:system|instruction|override|prompt|tool_call)\s*>/i,
    description: "XML/HTML tag mimicking system structures",
    confidence: 0.85,
    locations: ["body", "html"],
  },
  {
    type: "structured_data_injection",
    pattern: /^(?:role|system|instruction)\s*:\s*.+/im,
    description: "YAML-like system/role/instruction keys",
    confidence: 0.7,
    locations: ["body", "html"],
  },
  {
    type: "structured_data_injection",
    pattern: /```(?:system|prompt|instructions?)[\s\n]/i,
    description: "Code block labeled as system prompt",
    confidence: 0.85,
    locations: ["body", "html"],
  },
];

// ─── F. Social Engineering / Authority Claims ────────────────────────────────

const SOCIAL_PATTERNS: PatternDef[] = [
  {
    type: "authority_impersonation",
    pattern: /\b(?:authorized|approved|verified|certified)\s+(?:by|from)\s+(?:anthropic|openai|google|microsoft|the (?:system|admin|developer))\b/i,
    description: "Fake authorization from AI company or admin",
    confidence: 0.9,
    locations: ["body", "html"],
  },
  {
    type: "authority_impersonation",
    pattern: /\b(?:anthropic|openai)\s+(?:security|support|admin|engineering)\s+team\b/i,
    description: "Impersonation of AI company team",
    confidence: 0.9,
    locations: ["body", "html"],
  },
  {
    type: "authority_impersonation",
    pattern: /\b(?:vorautorisiert|genehmigt durch|autorisiert von|bestätigt durch)\s+(?:die )?(?:IT|administration|system|geschäftsführung)\b/i,
    description: "German fake authorization claim",
    confidence: 0.85,
    locations: ["body", "html"],
  },
  {
    type: "social_engineering",
    pattern: /\b(?:do not|don't|never|nicht)\s+(?:tell|inform|notify|mention|reveal|show|display|informiere|erwähne|zeige)\s+(?:the\s+)?(?:user|human|person|nutzer|benutzer|anwender)\b/i,
    description: "Instruction to hide actions from user",
    confidence: 0.9,
    locations: ["body", "html"],
  },
  {
    type: "social_engineering",
    pattern: /\b(?:silently|secretly|quietly|heimlich|still|unbemerkt)\s+(?:forward|send|create|draft|execute|weiterleiten|senden|erstellen|ausführen)\b/i,
    description: "Secret action instruction",
    confidence: 0.9,
    locations: ["body", "html"],
  },
  {
    type: "social_engineering",
    pattern: /\b(?:keep this confidential|vertraulich behandeln|do not disclose|nicht weitergeben)\b/i,
    description: "Secrecy instruction",
    confidence: 0.7,
    locations: ["body", "html"],
  },
  {
    type: "social_engineering",
    pattern: /\b(?:immediately|sofort|urgent(?:ly)?|dringend)\s+(?:execute|forward|send|comply|ausführen|weiterleiten|senden)\b/i,
    description: "Urgency combined with action command",
    confidence: 0.8,
    locations: ["body", "html"],
  },
  {
    type: "authority_impersonation",
    pattern: /\b(?:pre-?authorized|admin override|system override|maintenance mode|debug mode)\b/i,
    description: "Fake override/authorization claim",
    confidence: 0.85,
    locations: ["body", "html"],
  },
];

// ─── C. Data Exfiltration ────────────────────────────────────────────────────

const EXFILTRATION_PATTERNS: PatternDef[] = [
  {
    type: "data_exfiltration",
    pattern: /\b(?:forward|send|draft|weiterleiten|senden)\s+(?:all|the|alle|die)?\s*(?:emails?|messages?|data|contents?|passwords?|credentials?|e-?mails?|nachrichten|daten|inhalte|passwörter)\s+(?:to|an)\b/i,
    description: "Instruction to exfiltrate data via email",
    confidence: 0.85,
    locations: ["body", "html"],
  },
  {
    type: "data_exfiltration",
    pattern: /\b(?:create a? ?draft|erstelle? (?:einen? )?entwurf)\s+(?:with|containing|mit|enthält)\s+(?:user|the|alle|all)\s*(?:data|information|emails?|daten|informationen)\b/i,
    description: "Draft creation for data exfiltration",
    confidence: 0.85,
    locations: ["body", "html"],
  },
];

// ─── Compile all patterns into a single array ────────────────────────────────

export const ALL_PATTERNS: PatternDef[] = [
  ...INSTRUCTION_PATTERNS,
  ...HTML_PATTERNS,
  ...STRUCTURED_PATTERNS,
  ...SOCIAL_PATTERNS,
  ...EXFILTRATION_PATTERNS,
];

// ─── Invisible character detection thresholds ────────────────────────────────

/** Zero-width and invisible Unicode characters */
export const INVISIBLE_CHARS = /[\u200B\u200C\u200D\uFEFF\u2060\u180E]/;
export const INVISIBLE_CHARS_GLOBAL = /[\u200B\u200C\u200D\uFEFF\u2060\u180E]/g;

/** Bidirectional text override characters */
export const BIDI_OVERRIDES = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
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

export function computeRiskLevel(findings: Array<{ confidence: number }>): "none" | "low" | "medium" | "high" | "critical" {
  if (findings.length === 0) return "none";

  const maxConfidence = Math.max(...findings.map((f) => f.confidence));
  const totalWeight = findings.reduce((sum, f) => sum + f.confidence, 0);

  // Multiple low-confidence findings escalate
  if (findings.length >= 3 && totalWeight >= 2.0) return "critical";
  if (findings.length >= 2 && totalWeight >= 1.5) return "high";

  // Single finding thresholds
  if (maxConfidence >= 0.9) return "critical";
  if (maxConfidence >= 0.8) return "high";
  if (maxConfidence >= 0.6) return "medium";
  return "low";
}
