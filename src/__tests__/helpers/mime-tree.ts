/**
 * Minimal MIME walker for FakeImap: produces an imapflow-style BODYSTRUCTURE and the raw
 * (still transfer-encoded) bytes of every leaf part, keyed by IMAP part number.
 */

export interface FakeStructureNode {
  part?: string;
  type: string;
  parameters?: Record<string, string>;
  encoding?: string;
  size?: number;
  /** Content-ID header value, as imapflow reports it. */
  id?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  childNodes?: FakeStructureNode[];
}

export interface MimeTree {
  structure: FakeStructureNode;
  parts: Map<string, Buffer>;
}

function splitHeaderBody(raw: Buffer): { head: string; body: Buffer } {
  const s = raw.toString("latin1");
  const match = /\r?\n\r?\n/.exec(s);
  if (!match) return { head: s, body: Buffer.alloc(0) };
  return { head: s.slice(0, match.index), body: raw.subarray(match.index + match[0].length) };
}

function headerField(head: string, name: string): string | undefined {
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const line = unfolded.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(name.length + 1).trim();
}

function parseValue(value: string | undefined): { value: string; params: Record<string, string> } {
  if (!value) return { value: "", params: {} };
  const [first, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const item of rest) {
    const eq = item.indexOf("=");
    if (eq < 0) continue;
    const key = item.slice(0, eq).trim().toLowerCase().replace(/\*\d*\*?$/, "");
    params[key] = item.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { value: first.trim().toLowerCase(), params };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walk(raw: Buffer, part: string | undefined, parts: Map<string, Buffer>): FakeStructureNode {
  const { head, body } = splitHeaderBody(raw);
  const contentType = parseValue(headerField(head, "content-type") ?? "text/plain; charset=us-ascii");
  const disposition = parseValue(headerField(head, "content-disposition"));
  const node: FakeStructureNode = {
    ...(part ? { part } : {}),
    type: contentType.value || "text/plain",
    parameters: contentType.params,
    encoding: (headerField(head, "content-transfer-encoding") ?? "7bit").toLowerCase(),
    size: body.length,
    ...(headerField(head, "content-id") ? { id: headerField(head, "content-id")!.trim() } : {}),
    ...(disposition.value ? { disposition: disposition.value, dispositionParameters: disposition.params } : {}),
  };

  const boundary = contentType.params.boundary;
  if (node.type.startsWith("multipart/") && boundary) {
    const text = body.toString("latin1");
    const delimiter = new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?:\\r?\\n|$)`, "g");
    const segments: string[] = [];
    let start = -1;
    let match: RegExpExecArray | null;
    while ((match = delimiter.exec(text))) {
      if (start >= 0) segments.push(text.slice(start, match.index));
      if (match[1]) break;
      start = delimiter.lastIndex;
    }
    node.childNodes = segments.map((segment, i) =>
      walk(Buffer.from(segment, "latin1"), part ? `${part}.${i + 1}` : String(i + 1), parts),
    );
    return node;
  }

  const key = part ?? "1";
  if (!part) node.part = "1";
  parts.set(key, body);
  return node;
}

export function mimeTree(raw: Buffer): MimeTree {
  const parts = new Map<string, Buffer>();
  return { structure: walk(raw, undefined, parts), parts };
}
