import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import type { Transporter } from "nodemailer";
import { simpleParser } from "mailparser";
import { errorMessage } from "../errors.js";
import * as log from "../logging/logger.js";
import { findDraftsFolder } from "./create-draft.js";

export function register(
  server: McpServer,
  getClient: () => Promise<ImapFlow>,
  transport: Transporter,
  fromAddress: string,
) {
  server.tool(
    "send_draft",
    "Send an existing draft email via SMTP. Supports the create_draft → review → send_draft workflow.",
    {
      uid: z.number().describe("UID of the draft in the Drafts folder"),
      deleteAfterSend: z.boolean().default(true).describe("Delete the draft after sending (default: true)"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ uid, deleteAfterSend }) => {
      try {
        const client = await getClient();
        const draftsFolder = await findDraftsFolder(client);

        // 1. Read the draft
        const lock = await client.getMailboxLock(draftsFolder);
        let to: string = "";
        let cc: string | undefined;
        let bcc: string | undefined;
        let subject: string = "";
        let text: string = "";
        let html: string | undefined;
        let inReplyTo: string | undefined;
        let references: string | undefined;
        let attachments: Array<{ filename?: string; contentType: string; content: Buffer }> = [];

        try {
          const raw = await client.download(uid.toString(), undefined, { uid: true });
          const parsed = await simpleParser(raw.content);

          // Extract recipients
          const toAddrs = parsed.to
            ? (Array.isArray(parsed.to) ? parsed.to.flatMap((t) => t.value) : parsed.to.value)
            : [];
          to = toAddrs.map((a) => a.address).filter(Boolean).join(", ");

          if (!to) {
            return {
              content: [{ type: "text", text: "Error: Draft has no recipients — cannot send" }],
              isError: true,
            };
          }

          const ccAddrs = parsed.cc
            ? (Array.isArray(parsed.cc) ? parsed.cc.flatMap((c) => c.value) : parsed.cc.value)
            : [];
          cc = ccAddrs.map((a) => a.address).filter(Boolean).join(", ") || undefined;

          const bccAddrs = parsed.bcc
            ? (Array.isArray(parsed.bcc) ? parsed.bcc.flatMap((b) => b.value) : parsed.bcc.value)
            : [];
          bcc = bccAddrs.map((a) => a.address).filter(Boolean).join(", ") || undefined;

          subject = parsed.subject || "";
          text = parsed.text || "";
          html = parsed.html || undefined;
          inReplyTo = parsed.inReplyTo;
          references = parsed.references
            ? (Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references)
            : undefined;

          // Extract attachments
          if (parsed.attachments?.length) {
            attachments = parsed.attachments.map((a) => ({
              filename: a.filename || undefined,
              contentType: a.contentType,
              content: a.content,
            }));
          }
        } catch (downloadError) {
          const msg = errorMessage(downloadError);
          return {
            content: [{ type: "text", text: `Error reading draft UID ${uid} from ${draftsFolder}: ${msg}` }],
            isError: true,
          };
        } finally {
          lock.release();
        }

        // 2. Send via SMTP
        const mailOptions: any = {
          from: fromAddress,
          to,
          subject,
          text,
        };
        if (cc) mailOptions.cc = cc;
        if (bcc) mailOptions.bcc = bcc;
        if (html) mailOptions.html = html;
        if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
        if (references) mailOptions.references = references;
        if (attachments.length > 0) {
          mailOptions.attachments = attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: a.content,
          }));
        }

        const info = await transport.sendMail(mailOptions);
        log.info("email.sent_draft", { to, subject, messageId: info.messageId });

        // 3. Optionally delete the draft
        let draftDeleted = false;
        if (deleteAfterSend) {
          try {
            const deleteLock = await client.getMailboxLock(draftsFolder);
            try {
              await client.messageDelete(uid.toString(), { uid: true });
              draftDeleted = true;
            } finally {
              deleteLock.release();
            }
          } catch {
            // Non-fatal: email was sent, draft deletion failed
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              messageId: info.messageId,
              to,
              subject,
              sentAt: new Date().toISOString(),
              draftDeleted,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error sending draft: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
