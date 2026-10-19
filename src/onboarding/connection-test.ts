import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { AccountConfig } from "../config/schema.js";
import type { AuthProvider, ImapAuth } from "../auth/provider.js";
import { imapSecurityOptions, pinFromEndpoint, smtpSecurityOptions } from "../connection-security.js";
import { diagnose, type Diagnosis } from "./diagnose.js";
import { SERVER_NAME, VERSION } from "../version.js";

export interface CapabilitySummary {
  specialUse: boolean;
  uidplus: boolean;
  move: boolean;
  idle: boolean;
  /** PERMANENTFLAGS contains \* — custom keywords like $Done can be stored. */
  customKeywords: boolean;
}

export type StepResult<T extends object = object> = ({ ok: true } & T) | { ok: false; diagnosis: Diagnosis; error: unknown };

/** A folder as the server lists it. */
export interface ListedFolder {
  path: string;
  delimiter?: string;
}

export interface AccountTestReport {
  /** `folders`: every listed folder, unfiltered by folder rules (doctor checks the deny patterns against it). */
  imap: StepResult<{ capabilities: CapabilitySummary; folderCount: number; folders: ListedFolder[] }>;
  /** Present when the account has SMTP configured. */
  smtp?: StepResult;
}

/** The part of ImapFlow the test needs (FakeImap satisfies it in tests). */
export interface ImapProbeClient {
  capabilities: Map<string, unknown>;
  mailbox: false | { permanentFlags?: Set<string> };
  list(): Promise<ListedFolder[]>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  logout(): Promise<void>;
}

export interface ConnectionTestDeps {
  connectImap?(account: AccountConfig, auth: ImapAuth): Promise<ImapProbeClient>;
  verifySmtp?(account: AccountConfig, provider: AuthProvider): Promise<void>;
  /** Preset of the detected provider, used for provider-specific hints. */
  presetId?: string;
}

async function defaultConnectImap(account: AccountConfig, auth: ImapAuth): Promise<ImapProbeClient> {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    ...imapSecurityOptions(account.imap.host, account.imap.port, pinFromEndpoint(account.imap)),
    auth,
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    clientInfo: { name: SERVER_NAME, version: VERSION },
  });
  await client.connect();
  return client;
}

async function defaultVerifySmtp(account: AccountConfig, provider: AuthProvider): Promise<void> {
  const endpoint = account.smtp!;
  const transport = nodemailer.createTransport({
    host: endpoint.host,
    port: endpoint.port,
    ...smtpSecurityOptions(endpoint.host, endpoint.port, pinFromEndpoint(endpoint)),
    auth: (await provider.smtpAuth()) as SMTPTransport.Options["auth"],
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

/**
 * Log in once to IMAP (list folders, read INBOX capabilities) and verify SMTP. No retries:
 * repeated failed logins can lock the mailbox. Nothing is changed on the server.
 */
export async function testAccountConnection(
  account: AccountConfig,
  provider: AuthProvider,
  deps: ConnectionTestDeps = {},
): Promise<AccountTestReport> {
  let imap: AccountTestReport["imap"];
  let client: ImapProbeClient | undefined;
  try {
    client = await (deps.connectImap ?? defaultConnectImap)(account, await provider.imapAuth());
    const folders = await client.list();
    const lock = await client.getMailboxLock("INBOX");
    let customKeywords: boolean;
    try {
      const permanent = client.mailbox ? client.mailbox.permanentFlags : undefined;
      customKeywords = !permanent || permanent.has("\\*");
    } finally {
      lock.release();
    }
    const has = (cap: string) => client!.capabilities.has(cap);
    imap = {
      ok: true,
      folderCount: folders.length,
      folders: folders.map((f) => ({ path: f.path, ...(f.delimiter ? { delimiter: f.delimiter } : {}) })),
      capabilities: { specialUse: has("SPECIAL-USE"), uidplus: has("UIDPLUS"), move: has("MOVE"), idle: has("IDLE"), customKeywords },
    };
  } catch (error) {
    imap = { ok: false, error, diagnosis: diagnose(error, { protocol: "imap", host: account.imap.host, port: account.imap.port, presetId: deps.presetId }) };
  } finally {
    await client?.logout().catch(() => {});
  }

  if (!account.smtp) return { imap };
  let smtp: StepResult;
  try {
    await (deps.verifySmtp ?? defaultVerifySmtp)(account, provider);
    smtp = { ok: true };
  } catch (error) {
    smtp = { ok: false, error, diagnosis: diagnose(error, { protocol: "smtp", host: account.smtp.host, port: account.smtp.port, presetId: deps.presetId }) };
  }
  return { imap, smtp };
}
