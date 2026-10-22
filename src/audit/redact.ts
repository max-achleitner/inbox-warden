export type AuditLevel = "minimal" | "standard";

/** Message content never enters the audit log, whatever a tool records. */
const CONTENT_KEYS = new Set(["body", "text", "html", "content", "raw", "source", "attachments"]);
const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential/i;
const MAX_STRING = 500;
const MAX_ARRAY = 200;
const MAX_DEPTH = 3;

function clip(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => clip(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) return "[nested]";
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

function sanitizeObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || CONTENT_KEYS.has(key.toLowerCase())) continue;
    out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : clip(value, depth);
  }
  return out;
}

function domains(list: unknown[]): string[] {
  return [...new Set(list.map((v) => String(v).split("@").pop()!.toLowerCase()))].sort();
}

/** Characters that end a local part when reading backwards from "@": whitespace, controls and address delimiters. */
function endsLocalPart(code: number): boolean {
  if (code <= 32 || code === 0x7f || code === 0x85 || code === 0xa0 || code === 0x2028 || code === 0x2029 || code === 0x3000) return true;
  // " ( ) , : ; < > @ [ \ ]
  return code === 34 || code === 40 || code === 41 || code === 44 || code === 58 || code === 59 || code === 60 || code === 62 ||
    code === 64 || code === 91 || code === 92 || code === 93;
}

/**
 * "…@domain" for every address in a text (level minimal keeps only domains). One pass: each "@" reads back
 * to the previous delimiter, which is never before the previous "@".
 */
export function withoutLocalParts(text: string): string {
  let out = "";
  let last = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > last && !endsLocalPart(text.charCodeAt(start - 1))) start--;
    if (start === at) continue;
    out += text.slice(last, start) + "…";
    last = at;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Prepare ToolInvocation.record() details for the audit log.
 * minimal: no subjects, recipient lists reduced to count + domains.
 */
export function sanitizeDetails(details: Record<string, unknown>, level: AuditLevel): Record<string, unknown> {
  const reduced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const lower = key.toLowerCase();
    if (level === "minimal" && lower === "subject") continue;
    if (level === "minimal" && (lower === "recipients" || lower === "newrecipients" || lower === "untrustedrecipients") && Array.isArray(value)) {
      reduced[`${key}Count`] = value.length;
      reduced[`${key}Domains`] = domains(value);
      continue;
    }
    reduced[key] = value;
  }
  return sanitizeObject(reduced, 0);
}
