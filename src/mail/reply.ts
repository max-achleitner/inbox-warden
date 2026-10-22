import type { AddressObject, EmailAddress } from "mailparser";
import { domainOf, relatedDomains } from "../policy/recipients.js";
import { fullText } from "./text.js";
import { visibleAddress, visibleString } from "./visible-text.js";

export interface Mailbox {
  name: string;
  address: string;
}

export interface OriginalMessage {
  from?: AddressObject;
  replyTo?: AddressObject;
  to?: AddressObject | AddressObject[];
  cc?: AddressObject | AddressObject[];
  subject?: string;
  date?: Date;
  text?: string;
  html?: string | false;
}

export type QuoteLanguage = "en" | "de";

/** Upper bound for quoted text so a reply to a huge newsletter stays a sane size. */
const MAX_QUOTED_CHARS = 20_000;

function walk(entry: EmailAddress): Mailbox[] {
  if (entry.group) return entry.group.flatMap(walk);
  return entry.address ? [{ name: entry.name ?? "", address: entry.address }] : [];
}

export function flattenAddresses(field: AddressObject | AddressObject[] | undefined): Mailbox[] {
  if (!field) return [];
  return (Array.isArray(field) ? field : [field]).flatMap((f) => f.value.flatMap(walk));
}

/**
 * Who a reply goes to. Reply-To wins over From (contact forms, mailing lists); reply-all adds the
 * original To/Cc. Own addresses and duplicates are removed case-insensitively. Replying to a message
 * we sent ourselves goes to its original recipients.
 */
export function replyRecipients(
  original: OriginalMessage,
  ownAddresses: string[],
  replyAll: boolean,
): { to: Mailbox[]; cc: Mailbox[] } {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const take = (list: Mailbox[]) =>
    list.filter((m) => {
      const key = m.address.toLowerCase();
      if (own.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const replyTo = flattenAddresses(original.replyTo);
  let to = take(replyTo.length > 0 ? replyTo : flattenAddresses(original.from));
  if (to.length === 0) to = take(flattenAddresses(original.to));
  const cc = replyAll ? take([...flattenAddresses(original.to), ...flattenAddresses(original.cc)]) : [];
  return { to, cc };
}

/**
 * A Reply-To on a different domain than the sender (a common invoice-fraud trick). Non-null only when the
 * reply really goes to the Reply-To address, i.e. the original has one, and one of its addresses is on a
 * domain unrelated to the From address's domain.
 */
export function replyToMismatch(original: OriginalMessage): { replyTo: string; from: string | null } | null {
  const from = flattenAddresses(original.from)[0]?.address;
  const fromDomain = from === undefined ? null : domainOf(from);
  for (const m of flattenAddresses(original.replyTo)) {
    if (from === undefined || fromDomain === null) return { replyTo: m.address, from: null };
    const d = domainOf(m.address);
    // an invisible character in the address (IDNA ignores it in the domain) is a look-alike trick, never a match
    if (d === null || visibleAddress(m.address) !== m.address || !relatedDomains(d, fromDomain)) return { replyTo: m.address, from };
  }
  return null;
}

/** "Re: " unless the subject already carries a reply prefix (Re, AW, Antw, SV, VS). */
export function replySubject(subject: string | undefined): string {
  const s = (subject ?? "").trim();
  return /^(re|aw|antw|sv|vs)(\[\d+\])?\s*:/i.test(s) ? s : `Re: ${s}`;
}

function formatMailbox(m: Mailbox | undefined): string {
  if (!m) return "unknown sender";
  return m.name ? `${m.name} <${m.address}>` : m.address;
}

export function formatDate(date: Date, language: QuoteLanguage, timeZone?: string): string {
  return date.toLocaleString(language === "de" ? "de-AT" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
}

function attribution(original: OriginalMessage, language: QuoteLanguage, timeZone?: string): string {
  const who = formatMailbox(flattenAddresses(original.from)[0]);
  if (!original.date) return language === "de" ? `${who} schrieb:` : `${who} wrote:`;
  const when = formatDate(original.date, language, timeZone);
  return language === "de" ? `Am ${when} schrieb ${who}:` : `On ${when}, ${who} wrote:`;
}

function originalText(original: OriginalMessage): string {
  return fullText(original).text;
}

/** Plain-text quote block: attribution line followed by "> "-prefixed original text. */
export function quotePlain(original: OriginalMessage, language: QuoteLanguage, timeZone?: string): string {
  let text = originalText(original).replace(/\r\n/g, "\n").trimEnd();
  if (text.length > MAX_QUOTED_CHARS) text = text.slice(0, MAX_QUOTED_CHARS) + "\n[…]";
  const quoted = text
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n");
  return `${attribution(original, language, timeZone)}\n${quoted}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** HTML quote block for replies that carry an HTML body. */
export function quoteHtml(original: OriginalMessage, language: QuoteLanguage, timeZone?: string): string {
  const inner = original.html
    ? original.html
    : `<pre style="white-space:pre-wrap">${escapeHtml(originalText(original).slice(0, MAX_QUOTED_CHARS))}</pre>`;
  return (
    `<div>${escapeHtml(attribution(original, language, timeZone))}</div>` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`
  );
}

export function formatAddressList(list: Mailbox[]): string {
  return list.map((m) => formatMailbox(m)).join(", ");
}

/** For tool results only: display names without invisible characters; the addresses stay exactly as they are. */
export function formatVisibleAddressList(list: Mailbox[]): string {
  return formatAddressList(list.map((m) => ({ ...m, name: visibleString(m.name) })));
}
