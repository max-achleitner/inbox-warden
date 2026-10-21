import { convert } from "html-to-text";
import { PREHEADER_PADDING_GLOBAL } from "../security/patterns.js";
import { mergeRemoved, stripInvisible, visibleHtml, type HiddenContentRemoved } from "./visible-text.js";

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
  textPartDiffers?: true;
  hiddenContentRemoved?: HiddenContentRemoved;
}

export interface FullText {
  text: string;
  generated: boolean;
  textPartDiffers?: true;
  /** From the HTML part (always when there is one) merged with the text part's report. */
  hidden?: HiddenContentRemoved;
  /** Removed text; for scanning only, never shown. */
  hiddenText: string;
  /** Cleaned HTML when the message has an HTML part. */
  html?: string;
}

/** A text part with at least this many distinct words the visible HTML lacks is not what the reader saw. */
export const TEXT_PART_EXTRA_WORDS = 5;

function convertHtml(html: string): string {
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

/** Visible text of an HTML string (hidden elements and invisible characters removed). */
export function htmlToText(html: string): string {
  return convertHtml(visibleHtml(html).html);
}

const URL_PATTERN = /(?:https?:\/\/|mailto:|www\.)\S+/gi;

function words(text: string): Set<string> {
  return new Set(text.normalize("NFKC").toLowerCase().replace(URL_PATTERN, " ").match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}

/** True when the plain-text part says something (at least TEXT_PART_EXTRA_WORDS distinct words) the visible HTML text does not. */
export function textPartDiffers(plain: string, visibleHtmlText: string): boolean {
  const known = words(visibleHtmlText);
  let extra = 0;
  for (const word of words(plain)) if (!known.has(word) && ++extra >= TEXT_PART_EXTRA_WORDS) return true;
  return false;
}

/**
 * The message text a reader sees. Hidden HTML and invisible characters are removed; the text part is used unless it
 * says more than the visible HTML (then the HTML text is shown and `textPartDiffers` is set). Preheader padding is dropped.
 */
export function fullText(parsed: TextSource): FullText {
  const clean = (text: string) => text.replace(PREHEADER_PADDING_GLOBAL, " ");
  const plain = parsed.text ? stripInvisible(parsed.text) : undefined;
  const plainText = plain ? clean(plain.text) : "";
  const vh = parsed.html ? visibleHtml(parsed.html) : undefined;
  const htmlText = vh ? clean(convertHtml(vh.html)) : "";
  const hidden = mergeRemoved(vh?.removed, plain?.removed);
  const hiddenText = [vh?.hiddenText, plain?.hiddenText].filter(Boolean).join("\n");
  const common = { hiddenText, ...(hidden ? { hidden } : {}), ...(vh ? { html: vh.html } : {}) };

  if (plainText && (!vh || htmlText.trim() === "" || !textPartDiffers(plainText, htmlText))) {
    return { text: plainText, generated: false, ...common };
  }
  if (vh) {
    const differs = plainText !== "";
    return { text: htmlText, generated: true, ...(differs ? { textPartDiffers: true as const } : {}), ...common };
  }
  return { text: "", generated: false, ...common };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** End index for a slice that does not split a UTF-16 surrogate pair (emoji etc.). */
function safeEnd(text: string, end: number): number {
  return end < text.length && end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) ? end - 1 : end;
}

/** A window of the message text for paging: [offset, offset + maxChars). */
export function pageText(full: FullText, opts: { maxChars: number; offset: number }): BoundedText {
  const { text, generated } = full;
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
    ...(full.textPartDiffers ? { textPartDiffers: true as const } : {}),
    ...(full.hidden ? { hiddenContentRemoved: full.hidden } : {}),
  };
}

export function boundedText(parsed: TextSource, opts: { maxChars: number; offset: number }): BoundedText {
  return pageText(fullText(parsed), opts);
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
