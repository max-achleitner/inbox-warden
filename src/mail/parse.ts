import { simpleParser, type ParsedMail } from "mailparser";

/**
 * Parse a raw message. `skipHtmlToText` stops mailparser from filling `text` of an HTML-only mail with its own
 * html-to-text run (hidden text included, which `fullText` would take for a text part) and from failing with
 * "Failed to parse HTML" on deeply nested HTML. For HTML-only mail `text` is "".
 */
export function parseMail(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw, { skipHtmlToText: true });
}
