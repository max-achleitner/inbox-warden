import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { requireSpecialFolder } from "../imap/folders.js";
import { strictAppend } from "../imap/strict.js";
import { composeMessage } from "../mail/compose.js";
import { fromHeader, withSignature } from "../mail/identity.js";
import { outgoingAttachmentsSchema, resolveOutgoingAttachments } from "../files/attachments.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

/** Shared by every tool that composes mail as one of the account's identities. */
export const senderShape = {
  from: z.string().optional().describe("Sender address; must be one of the account's configured addresses (default: the account's main address)"),
  signature: z.boolean().default(true).describe("Append the sender's configured signature"),
};

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "create_draft",
      title: "Create draft",
      description:
        "Create a draft email and save it to the Drafts folder for review before sending. " +
        "Uses the sender's display name and signature. Returns the draft's uid for send_draft.",
      tier: "write",
      input: {
        to: z.string().describe("Recipient email address(es), comma-separated"),
        subject: z.string().describe("Email subject"),
        body: z.string().describe("Email body (plain text)"),
        cc: z.string().optional().describe("CC recipients, comma-separated"),
        bcc: z.string().optional().describe("BCC recipients, comma-separated"),
        html: z.string().optional().describe("HTML body (optional, plain text is always included)"),
        attachments: outgoingAttachmentsSchema,
        ...senderShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      errorPrefix: "Error creating draft",
    },
    async ({ to, subject, body, cc, bcc, html, attachments, from, signature }, inv) => {
      const resolvedAttachments = await resolveOutgoingAttachments(app.config.files, attachments);

      const identity = inv.account.identityFor(from);
      const content = withSignature({ text: body, html }, identity, signature);
      const client = await inv.account.getClient();
      const draftsFolder = await requireSpecialFolder(client, "\\Drafts");
      const message = await composeMessage({
        from: fromHeader(identity),
        to,
        cc,
        bcc,
        subject,
        text: content.text,
        html: content.html,
        attachments: resolvedAttachments,
      });
      const { uid } = await strictAppend(client, draftsFolder, message.raw, ["\\Draft", "\\Seen"]);
      inv.record({ folder: draftsFolder, messageId: message.messageId, recipients: message.envelope.to });

      return jsonResult({ success: true, folder: draftsFolder, uid, messageId: message.messageId, from: identity.email, to, subject });
    },
  );
}
