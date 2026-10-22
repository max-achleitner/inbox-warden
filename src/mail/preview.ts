import type { ImapFlow, MessageStructureObject } from "imapflow";
import { convert } from "html-to-text";
import { PREHEADER_PADDING_GLOBAL } from "../security/patterns.js";
import { stripInvisible, visibleHtml } from "./visible-text.js";

/** Bytes fetched per message for a preview. HTML gets more because <head>/<style> often fill the first KBs. */
const PLAIN_FETCH_BYTES = 4096;
const HTML_FETCH_BYTES = 16384;

export interface PreviewPart {
  key: string;
  isHtml: boolean;
  encoding: string;
  charset: string;
}

/** First inline text/plain part; otherwise the first inline text/html part. Attachments are skipped. */
export function findPreviewPart(structure: MessageStructureObject | undefined): PreviewPart | null {
  let html: PreviewPart | null = null;
  const visit = (node: MessageStructureObject, isRoot: boolean): PreviewPart | null => {
    if (node.childNodes && node.childNodes.length > 0) {
      for (const child of node.childNodes) {
        const found = visit(child, false);
        if (found) return found;
      }
      return null;
    }
    if (node.disposition === "attachment") return null;
    const type = (node.type || "").toLowerCase();
    if (type !== "text/plain" && type !== "text/html") return null;
    const part: PreviewPart = {
      key: node.part ?? (isRoot ? "1" : ""),
      isHtml: type === "text/html",
      encoding: (node.encoding || "7bit").toLowerCase(),
      charset: node.parameters?.charset || "utf-8",
    };
    if (!part.key) return null;
    if (!part.isHtml) return part;
    html ??= part;
    return null;
  };
  if (!structure) return null;
  return visit(structure, true) ?? html;
}

function decodeQuotedPrintable(input: string): Buffer {
  // remove soft line breaks and a possibly truncated escape at the very end
  const s = input.replace(/=\r?\n/g, "").replace(/=(?:[0-9A-Fa-f]|\r)?$/, "");
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

function decodeCharset(bytes: Buffer, charset: string): string {
  let text: string;
  try {
    text = new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  return text.replace(/�+$/, ""); // a multi-byte character cut off by the partial fetch
}

/** Decode the first bytes of a body part; tolerates truncation in the middle of base64/QP sequences. */
export function decodePartialBody(raw: Buffer, encoding: string, charset: string): string {
  if (encoding === "base64") {
    const clean = raw.toString("latin1").replace(/[^A-Za-z0-9+/]/g, "");
    return decodeCharset(Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64"), charset);
  }
  if (encoding === "quoted-printable") {
    return decodeCharset(decodeQuotedPrintable(raw.toString("latin1")), charset);
  }
  return decodeCharset(raw, charset);
}

/** Collapse to a single line of at most `chars` characters. */
export function previewText(decoded: string, isHtml: boolean, chars: number): string {
  const text = isHtml
    ? convert(visibleHtml(decoded).html, {
        wordwrap: false,
        selectors: [
          { selector: "a", options: { ignoreHref: true } },
          { selector: "img", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "script", format: "skip" },
          { selector: "head", format: "skip" },
        ],
      })
    : stripInvisible(decoded).text;
  const collapsed = text.replace(PREHEADER_PADDING_GLOBAL, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > chars ? `${collapsed.slice(0, chars - 1).trimEnd()}…` : collapsed;
}

/**
 * Preview snippets for messages in the currently selected mailbox.
 * One FETCH for BODYSTRUCTURE, then one partial BODY.PEEK fetch per distinct part key.
 */
export async function previewFor(client: ImapFlow, uids: number[], chars: number): Promise<Map<number, string>> {
  const previews = new Map<number, string>();
  if (uids.length === 0) return previews;

  const parts = new Map<number, PreviewPart>();
  for await (const msg of client.fetch(uids, { uid: true, bodyStructure: true }, { uid: true })) {
    const part = findPreviewPart(msg.bodyStructure);
    if (part) parts.set(msg.uid, part);
  }

  const groups = new Map<string, { key: string; maxLength: number; uids: number[] }>();
  for (const [uid, part] of parts) {
    const maxLength = part.isHtml ? HTML_FETCH_BYTES : PLAIN_FETCH_BYTES;
    const id = `${part.key}|${maxLength}`;
    const group = groups.get(id) ?? { key: part.key, maxLength, uids: [] };
    group.uids.push(uid);
    groups.set(id, group);
  }

  for (const group of groups.values()) {
    for await (const msg of client.fetch(
      group.uids,
      { uid: true, bodyParts: [{ key: group.key, start: 0, maxLength: group.maxLength }] },
      { uid: true },
    )) {
      const part = parts.get(msg.uid);
      const raw = msg.bodyParts?.get(group.key.toLowerCase()) ?? msg.bodyParts?.get(group.key);
      if (!part || !raw) continue;
      previews.set(msg.uid, previewText(decodePartialBody(raw, part.encoding, part.charset), part.isHtml, chars));
    }
  }
  return previews;
}
