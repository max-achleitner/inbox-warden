const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential/i;
/** Message content and subjects are personal data — never written to logs. */
const CONTENT_KEYS = new Set(["body", "text", "html", "content", "subject", "raw", "source"]);
const CREDENTIAL_IN_TEXT = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const MAX_DEPTH = 4;

export function redactString(value: string): string {
  return value.replace(CREDENTIAL_IN_TEXT, "$1 [REDACTED]");
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? "[nested]" : value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return depth >= MAX_DEPTH ? "[nested]" : redactLogData(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

/** Copy of `data` with secrets replaced and message content omitted. */
export function redactLogData(data: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (CONTENT_KEYS.has(key.toLowerCase())) out[key] = "[omitted]";
    else if (SECRET_KEY.test(key)) out[key] = "[REDACTED]";
    else out[key] = redactValue(value, depth);
  }
  return out;
}

/**
 * Remove credentials from one IMAP protocol line: LOGIN arguments, AUTHENTICATE initial
 * responses (SASL-IR, XOAUTH2) and base64 continuation lines sent by the client.
 */
export function redactImapLine(src: string | undefined, msg: string): string {
  const login = /^(\S+\s+LOGIN)\s.*$/i.exec(msg);
  if (login) return `${login[1]} [REDACTED]`;
  const auth = /^(\S+\s+AUTHENTICATE\s+\S+)(\s.*)?$/i.exec(msg);
  if (auth) return auth[2] ? `${auth[1]} [REDACTED]` : auth[1];
  if (src === "c" && /^[A-Za-z0-9+/]{8,}={0,2}$/.test(msg.trim())) return "[REDACTED]";
  return redactString(msg);
}
