import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { simpleParser } from "mailparser";
import type { AppContext } from "../context.js";
import { errorMessage } from "../errors.js";
import * as log from "../logging/logger.js";
import { requireSpecialFolder } from "../imap/folders.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { markOriginalAnswered } from "../mail/answered.js";
import { downloadMessage, safeExpunge } from "../imap/strict.js";
import { getHeader, removeHeaders, rfc5322Date, setHeader } from "../mail/headers.js";
import { flattenAddresses, formatAddressList } from "../mail/reply.js";
import { deliver, type DeliveryResult } from "../mail/send.js";
import { operationDigest } from "../policy/confirm-state.js";
import { guardOutbound } from "../policy/outbound.js";
import { OUTBOUND_NOTE } from "../instructions.js";
import { defineTool } from "./shared/define-tool.js";
import { errorResult, jsonResult } from "./shared/result.js";

/** Client bookkeeping headers that must not leave the mailbox. Bcc is stripped later by deliver(). */
const DRAFT_ONLY_HEADERS = [
  "x-mozilla-draft-info",
  "x-uniform-type-identifier",
  "x-universally-unique-identifier",
  "x-apple-mail-remote-attachments",
  "x-apple-base-url",
];

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "send_draft",
      title: "Send draft",
      description:
        "Send an existing draft exactly as it is stored in the Drafts folder (what you review is what is sent). " +
        "Supports the create_draft → review → send_draft workflow. A copy is filed in Sent." + OUTBOUND_NOTE,
      tier: "send",
      input: {
        uid: z.number().int().positive().describe("UID of the draft in the Drafts folder"),
        deleteAfterSend: z.boolean().default(true).describe("Delete the draft after sending (default: true)"),
        originalFolder: z
          .string()
          .optional()
          .describe("Folder of the email this draft replies to (originalFolder from reply_draft), so it can be marked as answered"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      errorPrefix: "Error sending draft",
      meta: { "anthropic/requiresUserInteraction": true },
    },
    async ({ uid, deleteAfterSend, originalFolder }, inv) => {
      const deps = inv.account.getSendDeps();
      const client = await inv.account.getClient();
      const draftsFolder = await requireSpecialFolder(client, "\\Drafts");

      const lock = await client.getMailboxLock(draftsFolder);
      let draftRaw: Buffer;
      try {
        draftRaw = await downloadMessage(client, uid, draftsFolder);
      } finally {
        try { lock.release(); } catch { /* connection may already be dead */ }
      }

      const parsed = await simpleParser(draftRaw);
      const sender = flattenAddresses(parsed.from)[0]?.address ?? "";
      if (!inv.account.ownAddresses.includes(sender.toLowerCase())) {
        return errorResult(
          "Error sending draft",
          `The draft's From address "${sender || "(none)"}" is not one of this account's addresses (${inv.account.ownAddresses.join(", ")}). Refusing to send.`,
        );
      }
      const recipients = [
        ...new Set(
          [...flattenAddresses(parsed.to), ...flattenAddresses(parsed.cc), ...flattenAddresses(parsed.bcc)].map((m) => m.address),
        ),
      ];
      if (recipients.length === 0) {
        return errorResult("Error sending draft", "Draft has no recipients — cannot send");
      }

      const outbound = await guardOutbound(inv, {
        action: "send_draft",
        from: sender,
        recipients,
        subject: parsed.subject ?? "",
        attachmentCount: parsed.attachments.length,
        digest: operationDigest({ uid, sha256: createHash("sha256").update(draftRaw).digest("hex") }),
      });
      if (!outbound.proceed) return outbound.result;

      let archiveRaw = setHeader(removeHeaders(draftRaw, DRAFT_ONLY_HEADERS), "Date", rfc5322Date(new Date()));
      let messageId = getHeader(archiveRaw, "message-id");
      if (!messageId) {
        messageId = `<${randomUUID()}@${sender.split("@")[1]}>`;
        archiveRaw = setHeader(archiveRaw, "Message-ID", messageId);
      }

      const reservation = inv.account.policy.reserveSend();
      let result: DeliveryResult;
      try {
        result = await deliver(deps, { archiveRaw, envelope: { from: sender, to: recipients }, messageId });
      } catch (err) {
        reservation.release();
        throw err;
      }

      // Best effort, after a successful send: keep "unanswered" filters correct — in visible folders only.
      const answeredFolders: string[] = [];
      for (const name of [originalFolder, "INBOX"]) {
        if (!name) continue;
        try {
          answeredFolders.push(await resolvePolicyFolder(inv.account, client, name));
        } catch {
          // unknown or hidden folder: skip it — the email is already sent
        }
      }
      const originalMarkedAnswered = await markOriginalAnswered(client, parsed.inReplyTo, answeredFolders);
      const to = formatAddressList(flattenAddresses(parsed.to));
      inv.record({ folder: draftsFolder, uids: [uid], messageId, recipients });
      log.info("email.sent_draft", { account: inv.account.id, recipients: recipients.length, messageId });

      let draftDeleted = false;
      let draftNote: string | undefined;
      if (deleteAfterSend) {
        try {
          const deleteLock = await client.getMailboxLock(draftsFolder);
          try {
            await safeExpunge(client, [uid]);
            draftDeleted = true;
          } finally {
            try { deleteLock.release(); } catch { /* ignore */ }
          }
        } catch (err) {
          // Non-fatal: the email was sent
          draftNote = `The email was sent, but the draft was not deleted: ${errorMessage(err)}`;
        }
      }

      return jsonResult({
        success: true,
        from: sender,
        to,
        subject: parsed.subject,
        sentAt: new Date().toISOString(),
        ...result,
        confirmation: outbound.confirmation,
        ...(outbound.newRecipients.length > 0 ? { newRecipients: outbound.newRecipients } : {}),
        draftDeleted,
        ...(draftNote ? { draftNote } : {}),
        originalMarkedAnswered,
      });
    },
  );
}
