/**
 * Byte-preserving edits on the header block of a raw RFC 5322 message.
 * The header block is handled as latin1 so 8-bit bytes round-trip unchanged.
 */

interface SplitMessage {
  lines: string[];
  eol: string;
  body: Buffer;
}

function split(raw: Buffer): SplitMessage {
  const text = raw.toString("latin1");
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  let end: number;
  let eol: string;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    end = crlf;
    eol = "\r\n";
  } else if (lf >= 0) {
    end = lf;
    eol = "\n";
  } else {
    return { lines: text.split(/\r?\n/).filter((l) => l !== ""), eol: "\r\n", body: Buffer.alloc(0) };
  }
  const head = text.slice(0, end);
  const body = raw.subarray(end + eol.length * 2);
  return { lines: head.split(eol), eol, body };
}

function join({ lines, eol, body }: SplitMessage): Buffer {
  return Buffer.concat([Buffer.from(lines.join(eol) + eol + eol, "latin1"), body]);
}

function fieldName(line: string): string {
  const colon = line.indexOf(":");
  return colon > 0 ? line.slice(0, colon).trim().toLowerCase() : "";
}

/** Remove every occurrence of the named header fields, including folded continuation lines. */
export function removeHeaders(raw: Buffer, names: string[]): Buffer {
  const parts = split(raw);
  const drop = new Set(names.map((n) => n.toLowerCase()));
  const kept: string[] = [];
  let skipping = false;
  for (const line of parts.lines) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = drop.has(fieldName(line));
    if (!skipping) kept.push(line);
  }
  return join({ ...parts, lines: kept });
}

/** Unfolded value of the first occurrence of a header field. */
export function getHeader(raw: Buffer, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const { lines } = split(raw);
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]/.test(lines[i]) || fieldName(lines[i]) !== wanted) continue;
    let value = lines[i].slice(lines[i].indexOf(":") + 1);
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) value += " " + lines[++i].trim();
    return value.trim();
  }
  return undefined;
}

/** Replace all occurrences of a header field with one new value (prepended when absent). */
export function setHeader(raw: Buffer, name: string, value: string): Buffer {
  const safeValue = value.replace(/[\r\n]+/g, " ");
  const without = removeHeaders(raw, [name]);
  const parts = split(without);
  return join({ ...parts, lines: [`${name}: ${safeValue}`, ...parts.lines] });
}

/** RFC 5322 date-time in UTC, e.g. "Wed, 14 Oct 2026 19:00:00 +0000". */
export function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, "+0000");
}
