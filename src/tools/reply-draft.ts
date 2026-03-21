import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { errorMessage } from "../errors.js";
import { buildRfc822Message, findDraftsFolder, validateAttachments } from "./create-draft.js";
import type { DraftAttachment } from "./create-draft.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>, fromAddress: string) {
  server.tool(
    "reply_draft",
    "Create a reply draft to an existing email, with proper threading headers (In-Reply-To, References). Saves to Drafts folder.",
    {
      folder: z.string().default("INBOX").describe("Folder containing the original email"),
      uid: z.number().describe("UID of the email to reply to"),
      body: z.string().describe("Reply body (plain text)"),
      replyAll: z.boolean().default(false).describe("Reply to all recipients, not just sender"),
      html: z.string().optional().describe("HTML reply body (optional)"),
      attachments: z.array(z.object({
        filename: z.string().describe("Attachment filename"),
        content: z.string().describe("Base64-encoded file content"),
        contentType: z.string().describe("MIME type, e.g. application/pdf"),
      })).optional().describe("File attachments (base64-encoded)"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ folder, uid, body, replyAll, html, attachments }) => {
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

        // Fetch the original email to get headers
        const lock = await client.getMailboxLock(folder);
        let originalMessageId: string | undefined;
        let originalReferences: string | undefined;
        let originalSubject: string = "";
        let originalFrom: string = "";
        let originalTo: string[] = [];
        let originalCc: string[] = [];

        try {
          const raw = await client.download(uid.toString(), undefined, { uid: true });
          const parsed = await simpleParser(raw.content);

          originalMessageId = parsed.messageId;
          originalReferences = parsed.references
            ? (Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references)
            : undefined;
          originalSubject = parsed.subject || "";
          originalFrom = parsed.from?.value?.[0]?.address || "";
          originalTo = parsed.to
            ? (Array.isArray(parsed.to)
              ? parsed.to.flatMap((t) => t.value.map((v) => v.address || ""))
              : parsed.to.value.map((v) => v.address || ""))
            : [];
          originalCc = parsed.cc
            ? (Array.isArray(parsed.cc)
              ? parsed.cc.flatMap((c) => c.value.map((v) => v.address || ""))
              : parsed.cc.value.map((v) => v.address || ""))
            : [];
        } finally {
          lock.release();
        }

        // Validate we have a sender to reply to
        if (!originalFrom) {
          return {
            content: [{ type: "text", text: "Error: Original email has no From address to reply to." }],
            isError: true,
          };
        }

        // Build reply headers
        const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
        const replyTo = originalFrom;
        let cc: string | undefined;

        if (replyAll) {
          // CC everyone who was on the original, minus ourselves
          const allRecipients = [...originalTo, ...originalCc]
            .filter((addr) => addr && addr !== fromAddress && addr !== replyTo);
          if (allRecipients.length > 0) {
            cc = allRecipients.join(", ");
          }
        }

        // Build References header: original references + original message-id
        let references: string | undefined;
        if (originalMessageId) {
          references = originalReferences
            ? `${originalReferences} ${originalMessageId}`
            : originalMessageId;
        }

        const draftsFolder = await findDraftsFolder(client);

        const rawMessage = buildRfc822Message({
          from: fromAddress,
          to: replyTo,
          subject,
          body,
          cc,
          html,
          inReplyTo: originalMessageId,
          references,
          attachments,
        });

        await client.append(draftsFolder, rawMessage, ["\\Draft", "\\Seen"]);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              folder: draftsFolder,
              to: replyTo,
              subject,
              replyAll,
              inReplyTo: originalMessageId,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error creating reply draft: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
