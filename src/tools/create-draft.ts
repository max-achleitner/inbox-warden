import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

/** Strip CRLF to prevent header injection */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** Encode a string as RFC 2047 base64 if it contains non-ASCII characters */
function encodeHeader(value: string): string {
  const safe = sanitizeHeaderValue(value);
  if (/^[\x20-\x7E]*$/.test(safe)) return safe;
  const encoded = Buffer.from(safe, "utf-8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

export interface DraftAttachment {
  filename: string;
  content: string;     // base64
  contentType: string;
}

/** Normalize bare \n to \r\n for RFC 2822 compliance */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function buildRfc822Message(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: DraftAttachment[];
}): string {
  const body = normalizeLineEndings(opts.body);
  const html = opts.html ? normalizeLineEndings(opts.html) : undefined;
  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@draft>`;

  const lines: string[] = [
    `From: ${sanitizeHeaderValue(opts.from)}`,
    `To: ${sanitizeHeaderValue(opts.to)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    `MIME-Version: 1.0`,
  ];

  if (opts.cc) lines.push(`Cc: ${sanitizeHeaderValue(opts.cc)}`);
  if (opts.bcc) lines.push(`Bcc: ${sanitizeHeaderValue(opts.bcc)}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeaderValue(opts.inReplyTo)}`);
  if (opts.references) lines.push(`References: ${sanitizeHeaderValue(opts.references)}`);

  const hasAttachments = opts.attachments && opts.attachments.length > 0;

  if (hasAttachments) {
    // multipart/mixed: body part + attachment parts
    const mixedBoundary = `----=_Mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    lines.push("");

    // Body part
    lines.push(`--${mixedBoundary}`);
    if (html) {
      const altBoundary = `----=_Alt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");
      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/plain; charset=utf-8");
      lines.push("Content-Transfer-Encoding: 8bit");
      lines.push("");
      lines.push(body);
      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/html; charset=utf-8");
      lines.push("Content-Transfer-Encoding: 8bit");
      lines.push("");
      lines.push(html!);
      lines.push(`--${altBoundary}--`);
    } else {
      lines.push("Content-Type: text/plain; charset=utf-8");
      lines.push("Content-Transfer-Encoding: 8bit");
      lines.push("");
      lines.push(body);
    }

    // Attachment parts
    for (const att of opts.attachments!) {
      lines.push(`--${mixedBoundary}`);
      lines.push(`Content-Type: ${sanitizeHeaderValue(att.contentType)}; name="${sanitizeHeaderValue(att.filename)}"`);
      lines.push("Content-Transfer-Encoding: base64");
      lines.push(`Content-Disposition: attachment; filename="${sanitizeHeaderValue(att.filename)}"`);
      lines.push("");
      // Split base64 into 76-char lines per RFC 2045
      const b64 = att.content;
      for (let i = 0; i < b64.length; i += 76) {
        lines.push(b64.slice(i, i + 76));
      }
    }
    lines.push(`--${mixedBoundary}--`);
  } else if (html) {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(body);
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(html!);
    lines.push(`--${boundary}--`);
  } else {
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(body);
  }

  return lines.join("\r\n");
}

const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024; // 25MB

function validateAttachments(attachments: DraftAttachment[]): string | null {
  let totalBytes = 0;
  for (const att of attachments) {
    // Check filename for path traversal
    if (/[/\\]|\.\./.test(att.filename)) {
      return `Error: Invalid attachment filename "${att.filename}" — must not contain /, \\, or ..`;
    }
    // Check valid base64
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(att.content.replace(/\s/g, ""))) {
      return `Error: Attachment "${att.filename}" contains invalid base64 content`;
    }
    // Accumulate size (base64 is ~4/3 of original)
    totalBytes += Math.ceil(att.content.replace(/\s/g, "").length * 3 / 4);
  }
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    const mb = (totalBytes / (1024 * 1024)).toFixed(1);
    return `Error: Total attachment size ${mb}MB exceeds 25MB limit`;
  }
  return null;
}

async function findDraftsFolder(client: ImapFlow): Promise<string> {
  const tree = await client.listTree();
  let draftsFolder: string | null = null;
  const allPaths: string[] = [];

  function walkTree(node: any) {
    if (node.specialUse === "\\Drafts") {
      draftsFolder = node.path;
    }
    allPaths.push(node.path);
    if (node.folders) node.folders.forEach(walkTree);
  }
  walkTree(tree);

  if (draftsFolder) return draftsFolder;

  // Fallback to common names
  for (const name of ["Drafts", "[Gmail]/Drafts", "Draft"]) {
    if (allPaths.includes(name)) return name;
  }

  throw new Error("Could not find Drafts folder");
}

export function register(server: McpServer, getClient: () => Promise<ImapFlow>, fromAddress: string) {
  server.tool(
    "create_draft",
    "Create a draft email and save it to the Drafts folder for review before sending",
    {
      to: z.string().describe("Recipient email address(es), comma-separated"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC recipients, comma-separated"),
      bcc: z.string().optional().describe("BCC recipients, comma-separated"),
      html: z.string().optional().describe("HTML body (optional, plain text is always included)"),
      attachments: z.array(z.object({
        filename: z.string().describe("Attachment filename"),
        content: z.string().describe("Base64-encoded file content"),
        contentType: z.string().describe("MIME type, e.g. application/pdf"),
      })).optional().describe("File attachments (base64-encoded)"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ to, subject, body, cc, bcc, html, attachments }) => {
      try {
        // Validate attachments
        if (attachments) {
          const validationError = validateAttachments(attachments);
          if (validationError) {
            return {
              content: [{ type: "text", text: validationError }],
              isError: true,
            };
          }
        }

        const client = await getClient();
        const draftsFolder = await findDraftsFolder(client);

        const raw = buildRfc822Message({
          from: fromAddress,
          to,
          subject,
          body,
          cc,
          bcc,
          html,
          attachments,
        });

        await client.append(draftsFolder, raw, ["\\Draft", "\\Seen"]);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              folder: draftsFolder,
              to,
              subject,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error creating draft: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}

export { buildRfc822Message, findDraftsFolder, validateAttachments };
