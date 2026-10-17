import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import * as log from "../logging/logger.js";
import { composeMessage, type ComposeInput } from "../mail/compose.js";
import { fromHeader, withSignature } from "../mail/identity.js";
import { deliver, type DeliveryResult } from "../mail/send.js";
import { senderShape } from "./create-draft.js";
import { operationDigest } from "../policy/confirm-state.js";
import { guardOutbound } from "../policy/outbound.js";
import { OUTBOUND_NOTE } from "../instructions.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "send_email",
      title: "Send email",
      description:
        "Send an email via SMTP immediately. Prefer create_draft so a human can review first. " +
        "A copy is filed in the Sent folder (unless the provider does that itself)." + OUTBOUND_NOTE,
      tier: "send",
      input: {
        to: z.string().describe("Recipient email address(es), comma-separated"),
        subject: z.string().describe("Email subject"),
        body: z.string().describe("Email body (plain text)"),
        cc: z.string().optional().describe("CC recipients, comma-separated"),
        bcc: z.string().optional().describe("BCC recipients, comma-separated"),
        ...senderShape,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      errorPrefix: "Error sending email",
      meta: { "anthropic/requiresUserInteraction": true },
    },
    async ({ to, subject, body, cc, bcc, from, signature }, inv) => {
      const identity = inv.account.identityFor(from);
      const deps = inv.account.getSendDeps();
      const content = withSignature({ text: body }, identity, signature);
      const input: ComposeInput = { from: fromHeader(identity), to, cc, bcc, subject, text: content.text };
      const message = await composeMessage(input);
      const outbound = await guardOutbound(inv, {
        action: "send_email",
        from: identity.email,
        recipients: message.envelope.to,
        subject,
        attachmentCount: input.attachments?.length ?? 0,
        digest: operationDigest(input),
      });
      if (!outbound.proceed) return outbound.result;
      const reservation = inv.account.policy.reserveSend();
      let result: DeliveryResult;
      try {
        result = await deliver(deps, { archiveRaw: message.raw, envelope: message.envelope, messageId: message.messageId });
      } catch (err) {
        reservation.release();
        throw err;
      }
      inv.record({ messageId: result.messageId, recipients: message.envelope.to });
      log.info("email.sent", { account: inv.account.id, recipients: message.envelope.to.length, messageId: result.messageId });
      return jsonResult({
        success: true,
        from: identity.email,
        to,
        subject,
        ...result,
        confirmation: outbound.confirmation,
        ...(outbound.newRecipients.length > 0 ? { newRecipients: outbound.newRecipients } : {}),
      });
    },
  );
}
