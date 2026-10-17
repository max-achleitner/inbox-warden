import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { simpleParser } from "mailparser";
import type { AppContext } from "../context.js";
import { requireSpecialFolder } from "../imap/folders.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { downloadMessage, strictAppend } from "../imap/strict.js";
import { composeMessage, type OutgoingAttachment } from "../mail/compose.js";
import { emlFilename, forwardInlineText, forwardSubject } from "../mail/forward.js";
import { removeHeaders } from "../mail/headers.js";
import { fromHeader, withSignature } from "../mail/identity.js";
import { MAX_ATTACHMENT_TOTAL_BYTES, outgoingAttachmentsSchema, resolveOutgoingAttachments } from "../files/attachments.js";
import { senderShape } from "./create-draft.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

/** Text for an attachment-mode forward without own words; without any text part MailComposer would inline the .eml. */
const ATTACHED_NOTE = { en: "Forwarded message attached.", de: "Weitergeleitete Nachricht im Anhang." } as const;

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "forward_draft",
      title: "Create a forward draft",
      description:
        "Create a draft that forwards an existing email. mode \"inline\" (default) puts the original below your text and keeps its file attachments; " +
        "mode \"attachment\" attaches the original email unchanged as an .eml file. Saves to Drafts for review — nothing is sent.",
      tier: "write",
      input: {
        folder: z.string().default("INBOX").describe("Folder containing the email to forward"),
        uid: z.number().int().positive().describe("UID of the email to forward"),
        to: z.string().min(1).describe("Recipient email address(es), comma-separated"),
        cc: z.string().optional().describe("CC recipients, comma-separated"),
        bcc: z.string().optional().describe("BCC recipients, comma-separated"),
        body: z.string().default("").describe("Your text above the forwarded message"),
        mode: z.enum(["inline", "attachment"]).default("inline").describe("inline = quote + original attachments; attachment = original as .eml"),
        language: z.enum(["en", "de"]).optional().describe('Language of the "Fwd:"/"WG:" prefix and header block (default: account locale)'),
        ...senderShape,
        attachments: outgoingAttachmentsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      errorPrefix: "Error creating forward draft",
    },
    async ({ folder, uid, to, cc, bcc, body, mode, language, from, signature, attachments }, inv) => {
      const identity = inv.account.identityFor(from);
      const lang = language ?? inv.account.config.locale;
      const extra = (await resolveOutgoingAttachments(app.config.files, attachments)) ?? [];

      const client = await inv.account.getClient();
      const path = await resolvePolicyFolder(inv.account, client, folder);
      const lock = await client.getMailboxLock(path);
      let raw: Buffer;
      try {
        raw = await downloadMessage(client, uid, path);
      } finally {
        try { lock.release(); } catch { /* connection may already be dead */ }
      }
      const original = await simpleParser(raw);

      const intro = withSignature({ text: body }, identity, signature).text;
      let text: string;
      let carried: OutgoingAttachment[];
      if (mode === "attachment") {
        text = intro || ATTACHED_NOTE[lang];
        // Sent copies keep their Bcc header; the forward recipients must not see those hidden recipients
        const eml = removeHeaders(raw, ["bcc"]);
        carried = [{ filename: emlFilename(original.subject), content: eml.toString("base64"), contentType: "message/rfc822" }];
      } else {
        text = `${intro}\n\n${forwardInlineText(original, lang)}`;
        carried = original.attachments
          .filter((a) => a.contentDisposition !== "inline" || !a.cid)
          .map((a, i) => ({
            filename: a.filename || `attachment_${i + 1}`,
            content: a.content.toString("base64"),
            contentType: a.contentType,
          }));
      }
      const all = [...carried, ...extra];
      const totalBytes = all.reduce((sum, a) => sum + Math.ceil((a.content.length * 3) / 4), 0);
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw new Error(`The forward would carry more than ${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB of attachments, which most mail servers reject. No draft was created.`);
      }

      const subject = forwardSubject(original.subject, lang);
      const draftsFolder = await requireSpecialFolder(client, "\\Drafts");
      const message = await composeMessage({
        from: fromHeader(identity),
        to,
        cc,
        bcc,
        subject,
        text,
        attachments: all.length > 0 ? all : undefined,
      });
      const { uid: draftUid } = await strictAppend(client, draftsFolder, message.raw, ["\\Draft", "\\Seen"]);

      inv.record({ folder: path, uids: [uid], action: "forward_draft", messageId: message.messageId, recipients: message.envelope.to });
      return jsonResult({
        success: true,
        folder: draftsFolder,
        uid: draftUid,
        messageId: message.messageId,
        to,
        subject,
        mode,
        attachments: all.map((a) => a.filename),
      });
    },
  );
}
