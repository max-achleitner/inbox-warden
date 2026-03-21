import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { errorMessage } from "../errors.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "download_attachment",
    "Download a specific attachment from an email. Returns the attachment as base64-encoded content.",
    {
      folder: z.string().default("INBOX").describe("Mailbox folder path"),
      uid: z.number().describe("Email UID"),
      attachmentIndex: z.number().min(0).describe("Attachment index (0-based, from read_email results)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ folder, uid, attachmentIndex }) => {
      try {
        const client = await getClient();
        const lock = await client.getMailboxLock(folder);

        try {
          const raw = await client.download(uid.toString(), undefined, { uid: true });
          const parsed = await simpleParser(raw.content);

          if (!parsed.attachments || attachmentIndex >= parsed.attachments.length) {
            return {
              content: [{
                type: "text",
                text: `Error: No attachment at index ${attachmentIndex}. Email has ${parsed.attachments?.length || 0} attachments.`,
              }],
              isError: true,
            };
          }

          const attachment = parsed.attachments[attachmentIndex];
          const filename = attachment.filename || `attachment_${attachmentIndex}`;
          const contentType = attachment.contentType;

          // Return text content directly for text-based formats
          const isText = contentType.startsWith("text/") ||
            ["application/json", "application/xml", "application/csv"].includes(contentType) ||
            /\.(txt|csv|json|xml|log|md|html|htm|yaml|yml|toml|ini|cfg|conf|sh|bat|ps1|py|js|ts|java|c|cpp|h|rb|go|rs|sql)$/i.test(filename);

          if (isText) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  filename,
                  contentType,
                  size: attachment.size,
                  encoding: "utf-8",
                  content: attachment.content.toString("utf-8"),
                }, null, 2),
              }],
            };
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                filename,
                contentType,
                size: attachment.size,
                encoding: "base64",
                content: attachment.content.toString("base64"),
              }, null, 2),
            }],
          };
        } finally {
          lock.release();
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error downloading attachment: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
