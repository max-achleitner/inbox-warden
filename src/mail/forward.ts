import type { AddressObject } from "mailparser";
import { flattenAddresses, formatAddressList, formatDate, type QuoteLanguage } from "./reply.js";
import { fullText } from "./text.js";

export interface ForwardSource {
  from?: AddressObject;
  to?: AddressObject | AddressObject[];
  cc?: AddressObject | AddressObject[];
  subject?: string;
  date?: Date;
  text?: string;
  html?: string | false;
}

const LABELS = {
  en: { title: "---------- Forwarded message ----------", from: "From", date: "Date", subject: "Subject", to: "To", cc: "Cc" },
  de: { title: "---------- Weitergeleitete Nachricht ----------", from: "Von", date: "Datum", subject: "Betreff", to: "An", cc: "Cc" },
} as const;

/** "Fwd: " (en) or "WG: " (de) unless the subject already carries a forward prefix. */
export function forwardSubject(subject: string | undefined, language: QuoteLanguage): string {
  const s = (subject ?? "").trim();
  if (/^(fwd?|wg|tr|fw)\s*:/i.test(s)) return s;
  return `${language === "de" ? "WG" : "Fwd"}: ${s}`;
}

/** Header block that introduces the forwarded message. */
export function forwardHeaderBlock(original: ForwardSource, language: QuoteLanguage, timeZone?: string): string {
  const l = LABELS[language];
  const lines = [l.title, `${l.from}: ${formatAddressList(flattenAddresses(original.from))}`];
  if (original.date) lines.push(`${l.date}: ${formatDate(original.date, language, timeZone)}`);
  lines.push(`${l.subject}: ${original.subject ?? ""}`);
  const to = flattenAddresses(original.to);
  if (to.length > 0) lines.push(`${l.to}: ${formatAddressList(to)}`);
  const cc = flattenAddresses(original.cc);
  if (cc.length > 0) lines.push(`${l.cc}: ${formatAddressList(cc)}`);
  return lines.join("\n");
}

/** Plain-text body of an inline forward: header block followed by the original text. */
export function forwardInlineText(original: ForwardSource, language: QuoteLanguage, timeZone?: string): string {
  return `${forwardHeaderBlock(original, language, timeZone)}\n\n${fullText(original).text.replace(/\r\n/g, "\n").trimEnd()}`;
}

/** File name for forwarding the original as message/rfc822. */
export function emlFilename(subject: string | undefined): string {
  const base = (subject ?? "").replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "_").trim().slice(0, 80);
  return `${base || "message"}.eml`;
}
