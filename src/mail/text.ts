import { convert } from "html-to-text";

export interface TextSource {
  text?: string;
  html?: string | false;
}

export interface BoundedText {
  text: string;
  totalChars: number;
  offset: number;
  truncated: boolean;
  nextOffset?: number;
  textGenerated?: true;
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: 120,
    selectors: [
      { selector: "a", options: { linkBrackets: ["[", "]"] } },
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
    ],
  });
}

/** The message text; generated from HTML when there is no text/plain part. */
export function fullText(parsed: TextSource): { text: string; generated: boolean } {
  if (parsed.text) return { text: parsed.text, generated: false };
  if (parsed.html) return { text: htmlToText(parsed.html), generated: true };
  return { text: "", generated: false };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** End index for a slice that does not split a UTF-16 surrogate pair (emoji etc.). */
function safeEnd(text: string, end: number): number {
  return end < text.length && end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
}

/** A window of the message text for paging: [offset, offset + maxChars). */
export function boundedText(parsed: TextSource, opts: { maxChars: number; offset: number }): BoundedText {
  const { text, generated } = fullText(parsed);
  const total = text.length;
  let start = Math.min(Math.max(0, opts.offset), total);
  if (start > 0 && start < total && isHighSurrogate(text.charCodeAt(start - 1))) start -= 1;
  const end = safeEnd(text, Math.min(total, start + opts.maxChars));
  return {
    text: text.slice(start, end),
    totalChars: total,
    offset: start,
    truncated: end < total,
    ...(end < total ? { nextOffset: end } : {}),
    ...(generated ? { textGenerated: true as const } : {}),
  };
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, safeEnd(text, maxChars - 1)).trimEnd()}…`, truncated: true };
}

const QUOTE_INTRO = new RegExp(
  [
    "^On .{3,200} wrote:\\s*$",
    "^Am .{3,200} schrieb .{1,200}:\\s*$",
    "^-{2,}\\s*(?:Original Message|Ursprüngliche Nachricht|Originalnachricht|Forwarded message|Weitergeleitete Nachricht)\\s*-{2,}\\s*$",
    "^_{10,}\\s*$",
  ].join("|"),
  "i",
);
const OUTLOOK_FROM = /^(?:From|Von):\s/i;
const OUTLOOK_SENT = /^(?:Sent|Gesendet|Date|Datum):\s/i;

/**
 * Remove quoted history so a thread view shows each message's own words once:
 * cuts at "On … wrote:", "Am … schrieb …:", "--- Original Message ---", an Outlook
 * "From:/Sent:" header block, and drops ">"-quoted lines.
 */
export function stripQuotedHistory(text: string): { text: string; stripped: boolean } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let stripped = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const outlookBlock =
      OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((next) => OUTLOOK_SENT.test(next));
    if (QUOTE_INTRO.test(line.trim()) || outlookBlock) {
      stripped = true;
      break;
    }
    if (line.startsWith(">")) {
      stripped = true;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").trim(), stripped };
}
