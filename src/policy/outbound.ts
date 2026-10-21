import type { ImapFlow } from "imapflow";
import type { InputRequiredResult } from "@modelcontextprotocol/server";
import type { ToolInvocation } from "../tools/shared/define-tool.js";
import { findSpecialFolder } from "../imap/folders.js";
import { strictSearch, visibleUids, type MessageScope } from "../imap/strict.js";
import { PolicyDeniedError, type PolicyEngine, type RiskLevel } from "./engine.js";
import { requireConfirmation } from "./confirm.js";

export interface OutboundRequest {
  action: "send_email" | "send_draft";
  from: string;
  /** Every envelope recipient (To, Cc and Bcc). */
  recipients: string[];
  subject: string;
  attachmentCount: number;
  /** operationDigest() of exactly what will be transmitted. */
  digest: string;
}

export type OutboundDecision =
  | {
      proceed: true;
      confirmation: "elicitation" | "client-approval" | "not-required";
      recipients: string[];
      newRecipients: string[];
    }
  | { proceed: false; result: InputRequiredResult };

/** What a tool needs from the account here (AccountRuntime satisfies it). */
export interface OutboundAccount {
  readonly policy: PolicyEngine;
  getClient(): Promise<ImapFlow>;
}

const MAX_NEW_RECIPIENT_LOOKUPS = 20;
/** Newest search hits checked for the exact address; a recipient not confirmed among them counts as new (the safe side). */
const MAX_VERIFIED_HITS = 50;

/** Does the To, Cc or Bcc of one of these (selected) messages contain exactly `address`? */
async function sentToExactly(client: ImapFlow, uids: number[], address: string): Promise<boolean> {
  if (uids.length === 0) return false;
  const wanted = address.toLowerCase();
  let found = false;
  for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
    const env = msg.envelope;
    const addresses = [...(env?.to ?? []), ...(env?.cc ?? []), ...(env?.bcc ?? [])];
    if (addresses.some((a) => a.address?.toLowerCase() === wanted)) found = true;
  }
  return found;
}

/**
 * Recipients that never appear in To/Cc/Bcc of the Sent folder. Lookups are capped; no Sent folder → none flagged.
 * Sent mail that `scope` hides does not count, so an address only written to there counts as new (the safe side).
 */
export async function findNewRecipients(client: ImapFlow, recipients: string[], scope: MessageScope): Promise<string[]> {
  const sent = await findSpecialFolder(client, "\\Sent");
  if (!sent) return [];
  const lock = await client.getMailboxLock(sent, { readOnly: true });
  try {
    const fresh: string[] = [];
    for (const address of recipients.slice(0, MAX_NEW_RECIPIENT_LOOKUPS)) {
      // IMAP address search matches substrings ("john@acme.co" finds "john@acme.com"): confirm the exact address
      const hits = await strictSearch(client, { or: [{ to: address }, { cc: address }, { bcc: address }] });
      const shown = await visibleUids(client, hits.slice(-MAX_VERIFIED_HITS), scope);
      if (!(await sentToExactly(client, shown, address))) fresh.push(address);
    }
    return fresh;
  } finally {
    try { lock.release(); } catch { /* connection may already be dead */ }
  }
}

function confirmationMessage(request: OutboundRequest, recipients: string[], newRecipients: string[], escalation: RiskLevel | null): string {
  const lines = [
    request.action === "send_draft" ? "Send this draft now?" : "Send this email now?",
    `From: ${request.from}`,
    `Recipients: ${recipients.join(", ")}`,
    `Subject: ${request.subject || "(no subject)"}`,
  ];
  if (request.attachmentCount > 0) lines.push(`Attachments: ${request.attachmentCount}`);
  if (newRecipients.length > 0) lines.push(`Never emailed before: ${newRecipients.join(", ")}`);
  if (escalation) {
    lines.push(
      `Warning: an email read in this session looked like a manipulation attempt (risk: ${escalation}). ` +
        "Only confirm if YOU asked for this email.",
    );
  }
  return lines.join("\n");
}

/**
 * Every outbound send passes here before SMTP: mode, recipient rules, rate limit, new-recipient
 * check, injection escalation and — when required — the human confirmation round.
 * Policy violations throw PolicyDeniedError (reported as "denied"); a pending confirmation
 * returns the input_required result the tool must return unchanged.
 */
export async function guardOutbound(
  inv: Pick<ToolInvocation, "sdk" | "record" | "clientCapabilities"> & { account: OutboundAccount },
  request: OutboundRequest,
): Promise<OutboundDecision> {
  const policy = inv.account.policy;
  if (policy.sendMode === "drafts-only") {
    throw new PolicyDeniedError(
      "Sending is switched off for this mailbox (drafts-only policy). Create a draft instead; a person sends it from the mail program.",
      "send.mode",
    );
  }
  const recipients = policy.checkRecipients(request.recipients);
  policy.checkRate();
  const newRecipients = policy.policy.send.flagNewRecipients
    ? await findNewRecipients(await inv.account.getClient(), recipients, policy.messageScope())
    : [];
  inv.record({
    recipients,
    subject: request.subject,
    attachmentCount: request.attachmentCount,
    ...(newRecipients.length > 0 ? { newRecipients } : {}),
  });

  const escalation = policy.injectionEscalation();
  // In confirm mode a finding only adds a warning to the dialog; in direct mode it forces one.
  const forced = policy.sendMode === "direct" && escalation !== null;
  if (policy.sendMode === "direct" && !forced) {
    inv.record({ confirmation: "not-required" });
    return { proceed: true, confirmation: "not-required", recipients, newRecipients };
  }

  const outcome = requireConfirmation(inv, {
    message: confirmationMessage(request, recipients, newRecipients, escalation),
    digest: request.digest,
    required: forced || policy.policy.send.requireElicitation,
  });
  switch (outcome.status) {
    case "pending":
      return { proceed: false, result: outcome.result };
    case "refused":
      throw new PolicyDeniedError(outcome.reason, forced ? "send.injectionEscalation" : "send.confirmation");
    case "confirmed":
      inv.record({ confirmation: "elicitation", ...(escalation ? { injectionEscalation: escalation } : {}) });
      return { proceed: true, confirmation: "elicitation", recipients, newRecipients };
    case "client-approval":
      inv.record({ confirmation: "client-approval", ...(escalation ? { injectionEscalation: escalation } : {}) });
      return { proceed: true, confirmation: "client-approval", recipients, newRecipients };
  }
}
