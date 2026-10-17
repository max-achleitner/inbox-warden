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

/**
 * Prepare ToolInvocation.record() details for the audit log.
 * minimal: no subjects, recipient lists reduced to count + domains.
 */
export function sanitizeDetails(details: Record<string, unknown>, level: AuditLevel): Record<string, unknown> {
  const reduced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const lower = key.toLowerCase();
    if (level === "minimal" && lower === "subject") continue;
    if (level === "minimal" && (lower === "recipients" || lower === "newrecipients") && Array.isArray(value)) {
      reduced[`${key}Count`] = value.length;
      reduced[`${key}Domains`] = domains(value);
      continue;
    }
    reduced[key] = value;
  }
  return sanitizeObject(reduced, 0);
}
