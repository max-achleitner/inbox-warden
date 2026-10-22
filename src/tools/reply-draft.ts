import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { parseMail } from "../mail/parse.js";
import type { AppContext } from "../context.js";
import { listFolderInfo, requireSpecialFolder } from "../imap/folders.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { downloadMessage, strictAppend } from "../imap/strict.js";
import { recipientWarnings } from "../policy/outbound.js";
import { composeMessage } from "../mail/compose.js";
import { withoutRemoteContent } from "../mail/outgoing-html.js";
import { fromHeader, withSignature } from "../mail/identity.js";
import { flattenAddresses, formatVisibleAddressList, quoteHtml, quotePlain, replyRecipients, replySubject, replyToMismatch } from "../mail/reply.js";
import { headerSeen } from "../policy/provenance.js";
import { stripTagCharacters, visibleAddress, visibleString } from "../mail/visible-text.js";
import { htmlFields, senderShape } from "./create-draft.js";
import { outgoingAttachmentsSchema, resolveOutgoingAttachments } from "../files/attachments.js";
import { defineTool } from "./shared/define-tool.js";
import { errorResult, jsonResult } from "./shared/result.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "reply_draft",
      title: "Create reply draft",
      description:
        "Create a reply draft to an existing email with threading headers (In-Reply-To, References). " +
        "Honors the Reply-To header and quotes the original message below your text and signature. Saves to Drafts. If the result has recipientWarnings, tell the user before they send the draft. If the result has replyToNote, tell the user. Remote images and other remote content in html are removed; linkTargets lists the links so the user can check them.",
      tier: "write",
      input: {
        folder: z.string().default("INBOX").describe("Folder containing the original email"),
        uid: z.number().int().positive().describe("UID of the email to reply to"),
        body: z.string().describe("Reply body (plain text), written above the quoted original"),
        replyAll: z.boolean().default(false).describe("Also reply to everyone in To/Cc of the original"),
        quoteOriginal: z.boolean().default(true).describe("Quote the original message below the reply"),
        language: z.enum(["en", "de"]).optional().describe('Language of the quote line ("On … wrote:" / "Am … schrieb …:"); default: the account locale'),
        html: z.string().optional().describe("HTML reply body (optional)"),
        attachments: outgoingAttachmentsSchema,
        ...senderShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      errorPrefix: "Error creating reply draft",
    },
    async ({ folder, uid, body, replyAll, quoteOriginal, language, html, attachments, from, signature }, inv) => {
      const resolvedAttachments = await resolveOutgoingAttachments(app.config.files, attachments);

      const identity = inv.account.identityFor(from);
      const quoteLanguage = language ?? inv.account.config.locale;
      const client = await inv.account.getClient();
      const folders = await listFolderInfo(client);
      const path = await resolvePolicyFolder(inv.account, client, folder, folders);
      const lock = await client.getMailboxLock(path);
      let original;
      try {
        original = await parseMail(await downloadMessage(client, uid, path, inv.account.policy.messageScope(folders)));
      } finally {
        try { lock.release(); } catch { /* connection may already be dead */ }
      }

      inv.provenance.noteSeen(
        headerSeen({
          from: flattenAddresses(original.from),
          replyTo: flattenAddresses(original.replyTo),
          to: flattenAddresses(original.to),
          cc: flattenAddresses(original.cc),
        }),
      );
      const { to, cc } = replyRecipients(original, inv.account.ownAddresses, replyAll);
      if (to.length === 0) {
        return errorResult("Error creating reply draft", "The original email has no sender or Reply-To address to reply to.");
      }

      const originalReferences = original.references
        ? (Array.isArray(original.references) ? original.references : [original.references])
        : [];
      const references = original.messageId ? [...originalReferences, original.messageId] : originalReferences;
      const subject = replySubject(original.subject);
      const cleaned = html === undefined ? undefined : withoutRemoteContent(html);
      const signed = withSignature({ text: body, html: cleaned?.html }, identity, signature);
      const text = quoteOriginal ? `${signed.text}\n\n${quotePlain(original, quoteLanguage)}` : signed.text;
      const htmlBody = signed.html && quoteOriginal ? `${signed.html}<br>${quoteHtml(original, quoteLanguage)}` : signed.html;

      const draftsFolder = await requireSpecialFolder(client, "\\Drafts", folders);
      const message = await composeMessage({
        from: fromHeader(identity),
        to,
        cc: cc.length > 0 ? cc : undefined,
        subject,
        text,
        html: htmlBody,
        inReplyTo: original.messageId,
        references: references.length > 0 ? references : undefined,
        attachments: resolvedAttachments,
      });
      const mismatch = replyToMismatch(original);
      const warnings = await recipientWarnings(inv, message.envelope.to);
      inv.account.policy.checkUntrustedRecipients(warnings, "draft");
      const { uid: draftUid } = await strictAppend(client, draftsFolder, message.raw, ["\\Draft", "\\Seen"]);
      inv.record({ folder: draftsFolder, messageId: message.messageId, recipients: message.envelope.to, untrustedRecipients: warnings.map((w) => w.address) });

      // The draft keeps the original's strings; the result shows them as a reader sees them (no invisible characters)
      return jsonResult({
        success: true,
        folder: draftsFolder,
        uid: draftUid,
        messageId: message.messageId,
        to: formatVisibleAddressList(to),
        ...(cc.length > 0 ? { cc: formatVisibleAddressList(cc) } : {}),
        subject: visibleString(subject),
        replyAll,
        inReplyTo: original.messageId === undefined ? undefined : stripTagCharacters(original.messageId).text,
        originalFolder: path,
        ...(warnings.length > 0 ? { recipientWarnings: warnings } : {}),
        ...htmlFields(cleaned),
        ...(mismatch
          ? {
              replyToNote:
                mismatch.from === null
                  ? `The reply goes to the Reply-To address ${visibleAddress(mismatch.replyTo)}, and the sender's address is unknown. Make sure the user wants the reply to go there.`
                  : `The reply goes to the Reply-To address ${visibleAddress(mismatch.replyTo)}, which is on a different domain than the sender ${visibleAddress(mismatch.from)}. Make sure the user wants the reply to go there.`,
            }
          : {}),
      });
    },
  );
}
