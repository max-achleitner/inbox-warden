import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

/** Encode a string as RFC 2047 base64 if it contains non-ASCII characters */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const encoded = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
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
}): string {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@draft>`;

  const lines: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    `MIME-Version: 1.0`,
  ];

  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);

  if (opts.html) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(opts.body);
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/html; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(opts.html);
    lines.push(`--${boundary}--`);
  } else {
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("Content-Transfer-Encoding: 8bit");
    lines.push("");
    lines.push(opts.body);
  }

  return lines.join("\r\n");
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
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ to, subject, body, cc, bcc, html }) => {
      try {
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

export { buildRfc822Message, findDraftsFolder };
