import { compile, type FormatCallback } from "html-to-text";
import { PREHEADER_PADDING_GLOBAL } from "../security/patterns.js";
import { mergeRemoved, stripInvisible, uncheckedHtml, visibleHtml, type HiddenContentRemoved, type HtmlNotChecked } from "./visible-text.js";

export type { HtmlNotChecked } from "./visible-text.js";

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
  /** Cleaned HTML when the message has an HTML part that could be checked. */
  html?: string;
  /** Why the HTML part was not checked for hidden text: `text` is the text part (or empty), the HTML's text is only scanned. */
  htmlNotChecked?: HtmlNotChecked;
}

/** Tool results carry the note for `htmlNotChecked`. */
export const HTML_NOT_CHECKED_NOTES: Readonly<Record<HtmlNotChecked, string>> = {
  "too-large":
    "This email's HTML is too large to check for hidden text, so it is not shown; Claude sees only its plain-text part, if it has one.",
  "too-complex":
    "This email's HTML is nested too deeply to check for hidden text, so it is not shown; Claude sees only its plain-text part, if it has one.",
  "contains-frames":
    "This email's HTML contains frames, whose content mail programs do not show, so it is not shown; Claude sees only its plain-text part, if it has one. Its plain-text part was not compared with the HTML.",
  "thread-budget":
    "This thread has more HTML than one call checks, so this message's HTML is not shown; Claude sees only its plain-text part, if it has one. Read it with read_email.",
};

/** The notes for an HTML attachment, which has no plain-text part (and is never read under a thread's budget). */
export const ATTACHMENT_NOT_CHECKED_NOTES: Readonly<Record<Exclude<HtmlNotChecked, "thread-budget">, string>> = {
  "too-large": "This HTML attachment is too large to check for hidden text, so its text is not shown.",
  "too-complex": "This HTML attachment is nested too deeply to check for hidden text, so its text is not shown.",
  "contains-frames": "This HTML attachment contains frames, whose content browsers do not show, so its text is not shown.",
};

/** `htmlNotChecked` and its note, for a tool result about an email or an HTML attachment. */
export function htmlNotCheckedFields(full: FullText, of: "email" | "attachment" = "email"): { htmlNotChecked?: HtmlNotChecked; note?: string } {
  const reason = full.htmlNotChecked;
  if (!reason) return {};
  const note = of === "attachment" && reason !== "thread-budget" ? ATTACHMENT_NOT_CHECKED_NOTES[reason] : HTML_NOT_CHECKED_NOTES[reason];
  return { htmlNotChecked: reason, note };
}

/**
 * A text part that has at least this many distinct words the visible HTML lacks, or lacks this many of the visible
 * HTML's words, is not what the reader saw.
 */
export const TEXT_PART_EXTRA_WORDS = 5;

/** Removes leading and trailing line breaks without a regex. */
function trimLineBreaks(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 10) start++;
  while (end > start && text.charCodeAt(end - 1) === 10) end--;
  return text.slice(start, end);
}

/** Blockquotes open in the conversion running now; html-to-text calls formatters synchronously. */
let quoteDepth = 0;

/**
 * html-to-text prefixes every line of a blockquote once per level, so 500 nested quotes turn 1 MB into 500 MB of work
 * and text. Only the outermost quote is marked ("> " per line, which stripQuotedHistory drops); nested ones are blocks.
 */
const outerQuote: FormatCallback = (elem, walk, builder) => {
  if (quoteDepth > 0) {
    builder.openBlock({ leadingLineBreaks: 2 });
    walk(elem.children, builder);
    builder.closeBlock({ trailingLineBreaks: 2 });
    return;
  }
  quoteDepth++;
  try {
    builder.openBlock({ leadingLineBreaks: 2, reservedLineLength: 2 });
    walk(elem.children, builder);
    builder.closeBlock({
      trailingLineBreaks: 2,
      blockTransform: (text) => trimLineBreaks(text).split("\n").map((line) => "> " + line).join("\n"),
    });
  } finally {
    quoteDepth--;
  }
};

const convertHtml = compile({
  // Word wrap splits the growing last word again for every inline element that adds to it: quadratic on a long run of
  // inline elements without whitespace (2 MB of "<td>x" took 25 s)
  wordwrap: false,
  formatters: { outerQuote },
  selectors: [
    { selector: "a", options: { linkBrackets: ["[", "]"] } },
    { selector: "blockquote", format: "outerQuote" },
    { selector: "img", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "script", format: "skip" },
  ],
});

/**
 * Visible text of a raw HTML string (hidden elements and invisible characters removed). It cleans the HTML itself, so
 * never pass it HTML that `visibleHtml` already cleaned: a second pass no longer sees the removed `<style>` rules and
 * can drop text that was styled through them.
 */
export function htmlToText(html: string): string {
  return convertHtml(visibleHtml(html).html);
}

const URL_PATTERN = /(?:https?:\/\/|mailto:|www\.)\S+/gi;
/** Outlook inline-image placeholders: `[cid:image001.png@01DA…]` or a bare `cid:…`. */
const CID_PATTERN = /\[?cid:[^\s\]]+\]?/gi;

function words(text: string): Set<string> {
  return new Set(text.normalize("NFKC").toLowerCase().replace(URL_PATTERN, " ").replace(CID_PATTERN, " ").match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}

function extraWords(text: string, known: Set<string>): boolean {
  let extra = 0;
  for (const word of words(text)) if (!known.has(word) && ++extra >= TEXT_PART_EXTRA_WORDS) return true;
  return false;
}

/**
 * True when the plain-text part and the visible HTML text say different things: one has at least
 * TEXT_PART_EXTRA_WORDS distinct words the other lacks (a text part that says more, or a stub that says less).
 */
export function textPartDiffers(plain: string, visibleHtmlText: string): boolean {
  const plainWords = words(plain);
  const htmlWords = words(visibleHtmlText);
  return extraWords(plain, htmlWords) || extraWords(visibleHtmlText, plainWords);
}

/**
 * The message text a reader sees. Hidden HTML and invisible characters are removed; the text part is used unless it
 * differs from the visible HTML text (then the HTML text is shown, `textPartDiffers` is set and the dropped text part
 * goes to `hiddenText` for the scanner). An empty visible HTML text keeps the text part. Preheader padding is dropped.
 * HTML that cannot be checked (too large, too complex, with frames) is never shown (`htmlNotChecked`): then only the text
 * part is. `skipHtml` takes that way without parsing the HTML, for a caller's own reason (a time budget).
 */
export function fullText(parsed: TextSource, options: { skipHtml?: HtmlNotChecked } = {}): FullText {
  const clean = (text: string) => text.replace(PREHEADER_PADDING_GLOBAL, " ");
  const plain = parsed.text ? stripInvisible(parsed.text) : undefined;
  const plainText = plain ? clean(plain.text) : "";
  const vh = parsed.html ? (options.skipHtml ? uncheckedHtml(parsed.html, options.skipHtml) : visibleHtml(parsed.html)) : undefined;
  if (vh?.notChecked) {
    // Fail closed: the unchecked HTML shows nothing, the text part is all a reader can be shown
    return {
      text: plainText,
      generated: false,
      hiddenText: [vh.hiddenText, plain?.hiddenText].filter(Boolean).join("\n"),
      ...(plain?.removed ? { hidden: plain.removed } : {}),
      htmlNotChecked: vh.notChecked,
    };
  }
  // Safety net: whatever the conversion prints (link targets, attribute text) is cleaned like a text node
  const converted = vh ? stripInvisible(convertHtml(vh.html)) : undefined;
  const htmlText = converted?.text ?? "";
  const hidden = mergeRemoved(vh?.removed, converted?.removed, plain?.removed);
  const hiddenText = [vh?.hiddenText, converted?.hiddenText, plain?.hiddenText].filter(Boolean).join("\n");
  const common = { hiddenText, ...(hidden ? { hidden } : {}), ...(vh ? { html: vh.html } : {}) };

  if (plainText && (!vh || htmlText.trim() === "" || !textPartDiffers(plainText, htmlText))) {
    return { text: plainText, generated: false, ...common };
  }
  if (vh) {
    if (plainText === "") return { text: htmlText, generated: true, ...common };
    // The reader saw the HTML; the text part is scanned (as hidden text) but never shown
    return {
      text: htmlText,
      generated: true,
      textPartDiffers: true,
      ...common,
      hiddenText: [hiddenText, plainText].filter(Boolean).join("\n"),
    };
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
