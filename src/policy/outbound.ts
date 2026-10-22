import type { ImapFlow } from "imapflow";
import type { InputRequiredResult } from "@modelcontextprotocol/server";
import type { ToolInvocation } from "../tools/shared/define-tool.js";
import { findSpecialFolder } from "../imap/folders.js";
import { strictSearch, visibleUids, type MessageScope } from "../imap/strict.js";
import { PolicyDeniedError, type PolicyEngine, type RiskLevel } from "./engine.js";
import { requireConfirmation } from "./confirm.js";
import type { ProvenanceChannel, RecipientWarningReason } from "./provenance.js";
import * as log from "../logging/logger.js";

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
      recipientWarnings: RecipientWarning[];
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
export async function findNewRecipients(
  client: ImapFlow,
  recipients: string[],
  scope: MessageScope,
  options: { assumeNew?: boolean } = {},
): Promise<string[]> {
  const sent = await findSpecialFolder(client, "\\Sent");
  if (!sent) return options.assumeNew ? [...recipients] : [];
  const lock = await client.getMailboxLock(sent, { readOnly: true });
  try {
    const fresh: string[] = [];
    for (const address of recipients.slice(0, MAX_NEW_RECIPIENT_LOOKUPS)) {
      // IMAP address search matches substrings ("john@acme.co" finds "john@acme.com"): confirm the exact address
      const hits = await strictSearch(client, { or: [{ to: address }, { cc: address }, { bcc: address }] });
      const shown = await visibleUids(client, hits.slice(-MAX_VERIFIED_HITS), scope);
      if (!(await sentToExactly(client, shown, address))) fresh.push(address);
    }
    // beyond the cap nothing was checked: with assumeNew those count as new
    if (options.assumeNew) fresh.push(...recipients.slice(MAX_NEW_RECIPIENT_LOOKUPS));
    return fresh;
  } finally {
    try { lock.release(); } catch { /* connection may already be dead */ }
  }
}

export interface RecipientWarning {
  address: string;
  reason: RecipientWarningReason;
  message: string;
}

function warningMessage(address: string, reason: RecipientWarningReason): string {
  switch (reason) {
    case "only-in-mail-content":
      return `${address} appears only inside a received email (its text, a link or its Reply-To), never as its sender or recipient, and this mailbox has never written to it.`;
    case "domain-only-in-mail-content":
      return `The domain of ${address} appears only inside a received email (its text or a link), and this mailbox has never written to ${address}.`;
    case "mail-content-not-tracked":
      return `Inbox Warden could not keep track of every address in the mail Claude read recently, and this mailbox has never written to ${address}.`;
  }
}

/**
 * Recipients that mail content named but no correspondence backs, and that this mailbox never wrote to.
 * Fail closed: when Sent cannot be checked, every candidate stays flagged.
 */
export async function recipientWarnings(
  inv: { provenance: ProvenanceChannel; account: OutboundAccount },
  recipients: string[],
): Promise<RecipientWarning[]> {
  const policy = inv.account.policy;
  const candidates = inv.provenance.contentOnly(recipients).filter((c) => !policy.isOwnDomain(c.address));
  if (candidates.length === 0) return [];
  let fresh: Set<string>;
  try {
    const client = await inv.account.getClient();
    fresh = new Set(await findNewRecipients(client, candidates.map((c) => c.address), policy.messageScope(), { assumeNew: true }));
  } catch {
    log.warn("provenance.sent_lookup_failed", { account: policy.accountId });
    fresh = new Set(candidates.map((c) => c.address));
  }
  return candidates
    .filter((c) => fresh.has(c.address))
    .map((c) => ({ address: c.address, reason: c.reason, message: warningMessage(c.address, c.reason) }));
}

const MAX_WARNING_LINES = 5;

function confirmationMessage(
  request: OutboundRequest,
  recipients: string[],
  newRecipients: string[],
  warnings: RecipientWarning[],
  escalation: RiskLevel | null,
): string {
  const lines = [
    request.action === "send_draft" ? "Send this draft now?" : "Send this email now?",
    `From: ${request.from}`,
    `Recipients: ${recipients.join(", ")}`,
    `Subject: ${request.subject || "(no subject)"}`,
  ];
  if (request.attachmentCount > 0) lines.push(`Attachments: ${request.attachmentCount}`);
  if (newRecipients.length > 0) lines.push(`Never emailed before: ${newRecipients.join(", ")}`);
  for (const w of warnings.slice(0, MAX_WARNING_LINES)) lines.push(`Check recipient: ${w.message}`);
  if (warnings.length > MAX_WARNING_LINES) {
    lines.push(`…and ${warnings.length - MAX_WARNING_LINES} more recipients that appear only inside received email.`);
  }
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
  inv: Pick<ToolInvocation, "sdk" | "record" | "clientCapabilities" | "provenance"> & { account: OutboundAccount },
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
  const warnings = await recipientWarnings(inv, recipients);
  policy.checkUntrustedRecipients(warnings, "send");
  inv.record({
    recipients,
    subject: request.subject,
    attachmentCount: request.attachmentCount,
    ...(newRecipients.length > 0 ? { newRecipients } : {}),
    ...(warnings.length > 0 ? { untrustedRecipients: warnings.map((w) => w.address) } : {}),
  });

  const escalation = policy.injectionEscalation();
  // In confirm mode a finding only adds a warning to the dialog; in direct mode it forces one.
  const forced = policy.sendMode === "direct" && escalation !== null;
  if (policy.sendMode === "direct" && !forced && warnings.length === 0) {
    inv.record({ confirmation: "not-required" });
    return { proceed: true, confirmation: "not-required", recipients, newRecipients, recipientWarnings: warnings };
  }

  const outcome = requireConfirmation(inv, {
    message: confirmationMessage(request, recipients, newRecipients, warnings, escalation),
    digest: request.digest,
    required: forced || policy.policy.send.requireElicitation || warnings.length > 0,
  });
  switch (outcome.status) {
    case "pending":
      return { proceed: false, result: outcome.result };
    case "refused":
      if (warnings.length > 0) {
        throw new PolicyDeniedError(
          `${outcome.reason} The confirmation is required because these recipients appear only inside a received email: ${warnings.map((w) => w.address).join(", ")}.`,
          "send.untrustedRecipients",
        );
      }
      throw new PolicyDeniedError(outcome.reason, forced ? "send.injectionEscalation" : "send.confirmation");
    case "confirmed":
      inv.record({ confirmation: "elicitation", ...(escalation ? { injectionEscalation: escalation } : {}) });
      return { proceed: true, confirmation: "elicitation", recipients, newRecipients, recipientWarnings: warnings };
    case "client-approval":
      inv.record({ confirmation: "client-approval", ...(escalation ? { injectionEscalation: escalation } : {}) });
      return { proceed: true, confirmation: "client-approval", recipients, newRecipients, recipientWarnings: warnings };
  }
}
