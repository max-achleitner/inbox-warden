import type { ImapFlow } from "imapflow";
import type Mail from "nodemailer/lib/mailer/index.js";
import { errorMessage } from "../errors.js";
import { findSpecialFolder } from "../imap/folders.js";
import { strictAppend, strictSearch } from "../imap/strict.js";
import { removeHeaders } from "./headers.js";

/**
 * auto   = skip for providers that file SMTP-sent mail themselves (Gmail, Microsoft 365), otherwise
 *          check the Sent folder once per server and append a copy when the server does not.
 * always = always append a copy.  never = never append.
 */
export type SentCopyMode = "auto" | "always" | "never";

/** The part of a nodemailer transport that deliver() needs; real transports satisfy it. */
export interface MailTransport {
  sendMail(mail: Mail.Options): Promise<{ accepted?: Array<string | Mail.Address>; rejected?: Array<string | Mail.Address> }>;
}

export interface SendDeps {
  transport: MailTransport;
  getClient: () => Promise<ImapFlow>;
  imapHost: string;
  sentCopy: SentCopyMode;
  /** Per IMAP host: does the server file sent mail itself? Filled by the first "auto" send. */
  sentProbeCache: Map<string, boolean>;
  /** How long to look for a server-filed copy before appending our own. */
  sentProbe?: { attempts: number; delayMs: number };
}

export interface OutgoingMessage {
  /** Exact bytes for the Sent folder, Bcc header included. */
  archiveRaw: Buffer;
  /** SMTP envelope; `to` contains every recipient including Bcc. */
  envelope: { from: string; to: string[] };
  messageId: string;
}

export interface SentCopyResult {
  saved: boolean;
  /** The provider or server stores sent mail in Sent itself, so a copy exists although we stored none. */
  filedByServer?: true;
  folder?: string;
  uid?: number;
  reason: string;
}

export interface DeliveryResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  sentCopy: SentCopyResult;
}

const MICROSOFT_IMAP_HOSTS = ["outlook.office365.com", "imap-mail.outlook.com", "outlook.office.com"];

/** Providers documented to store SMTP-submitted mail in Sent by themselves. */
export function providerFilesSentMail(client: ImapFlow, imapHost: string): boolean {
  if (client.capabilities.has("X-GM-EXT-1")) return true; // Gmail / Google Workspace
  return MICROSOFT_IMAP_HOSTS.includes(imapHost.toLowerCase());
}

function addresses(list: unknown[] | undefined): string[] {
  return (list ?? []).map((a) => (typeof a === "string" ? a : (a as { address: string }).address));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sentFolderHasMessage(
  client: ImapFlow,
  folder: string,
  messageId: string,
  probe: { attempts: number; delayMs: number },
): Promise<boolean> {
  for (let attempt = 0; attempt < probe.attempts; attempt++) {
    if (attempt > 0) await sleep(probe.delayMs);
    const lock = await client.getMailboxLock(folder);
    try {
      if ((await strictSearch(client, { header: { "message-id": messageId } })).length > 0) return true;
    } finally {
      try { lock.release(); } catch { /* connection may already be dead */ }
    }
  }
  return false;
}

async function storeSentCopy(deps: SendDeps, msg: OutgoingMessage): Promise<SentCopyResult> {
  if (deps.sentCopy === "never") {
    return { saved: false, reason: "Saving a copy to the Sent folder is disabled in the configuration." };
  }
  const client = await deps.getClient();
  if (deps.sentCopy === "auto" && providerFilesSentMail(client, deps.imapHost)) {
    return { saved: false, filedByServer: true, reason: "The mail provider files sent mail into the Sent folder itself." };
  }
  const folder = await findSpecialFolder(client, "\\Sent");
  if (!folder) return { saved: false, reason: "No Sent folder was found, so no copy was stored." };

  if (deps.sentCopy === "auto") {
    let serverFiles = deps.sentProbeCache.get(deps.imapHost);
    if (serverFiles === undefined) {
      serverFiles = await sentFolderHasMessage(client, folder, msg.messageId, deps.sentProbe ?? { attempts: 2, delayMs: 1500 });
      deps.sentProbeCache.set(deps.imapHost, serverFiles);
    }
    if (serverFiles) {
      return { saved: false, filedByServer: true, folder, reason: "The mail server files sent mail into the Sent folder itself." };
    }
  }

  const { uid } = await strictAppend(client, folder, msg.archiveRaw, ["\\Seen"]);
  return { saved: true, folder, uid, reason: "A copy was stored in the Sent folder." };
}

/**
 * Transmit exactly the archived bytes minus the Bcc header, then file the copy in Sent.
 * A failure to store the copy never turns a successful send into an error (that would invite a resend).
 */
export async function deliver(deps: SendDeps, msg: OutgoingMessage): Promise<DeliveryResult> {
  const info = await deps.transport.sendMail({
    envelope: msg.envelope,
    raw: removeHeaders(msg.archiveRaw, ["bcc"]),
  });
  let sentCopy: SentCopyResult;
  try {
    sentCopy = await storeSentCopy(deps, msg);
  } catch (err) {
    sentCopy = { saved: false, reason: `The email WAS sent, but storing a copy in the Sent folder failed: ${errorMessage(err)}` };
  }
  return {
    messageId: msg.messageId,
    accepted: addresses(info.accepted),
    rejected: addresses(info.rejected),
    sentCopy,
  };
}
