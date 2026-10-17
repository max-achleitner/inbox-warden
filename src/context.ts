import * as path from "node:path";
import nodemailer from "nodemailer";
import type { ImapFlow } from "imapflow";
import type { AccountConfig, AppConfig, Identity, PermissionTier } from "./config/schema.js";
import type { SecretStore } from "./secrets/store.js";
import { createAuthProvider, type AuthProvider } from "./auth/provider.js";
import { ImapConnectionManager, type ConnectionStats } from "./imap-client.js";
import { pinFromEndpoint, smtpSecurityOptions } from "./connection-security.js";
import type { MailTransport, SendDeps } from "./mail/send.js";
import * as log from "./logging/logger.js";
import { CONFIG_DIR } from "./config/load.js";
import { PolicyEngine, tierAllowed } from "./policy/engine.js";
import { InjectionRiskObserver } from "./policy/observer.js";
import { SERVER_NAME } from "./version.js";

export interface AccountRuntime {
  readonly id: string;
  readonly config: AccountConfig;
  /** Lower-cased account email plus every identity email. */
  readonly ownAddresses: string[];
  getClient(): Promise<ImapFlow>;
  /** Throws a plain-language error when the account has no SMTP server. */
  getSendDeps(): SendDeps;
  /** Default identity, or the one whose email matches `from`; throws for unknown senders. */
  identityFor(from?: string): Identity;
  connectionStats(): ConnectionStats;
  shutdown(): Promise<void>;
  /** Policy decisions for this account (Plan 5). */
  readonly policy: PolicyEngine;
}

export interface ToolCallEvent {
  tool: string;
  accountId: string;
  tier: PermissionTier | "always";
  outcome: "success" | "error" | "denied";
  durationMs: number;
  details: Record<string, unknown>;
  error?: string;
}

export interface ToolObserver {
  onToolCall(event: ToolCallEvent): void | Promise<void>;
}

export interface AppContext {
  readonly config: AppConfig;
  readonly accounts: ReadonlyMap<string, AccountRuntime>;
  readonly defaultAccountId: string;
  readonly observers: ToolObserver[];
  /** The store the app was created with (the sign_in tool saves refresh tokens here). */
  readonly secrets: SecretStore;
  resolveAccount(id: string | undefined): AccountRuntime;
  anyAccountAllows(tier: PermissionTier): boolean;
  shutdown(): Promise<void>;
}

/** Test seams; production uses real IMAP connections and SMTP transports. */
export interface AppContextDeps {
  connectImap?(account: AccountConfig): () => Promise<ImapFlow>;
  createTransport?(account: AccountConfig): MailTransport;
  sentProbe?: { attempts: number; delayMs: number };
  /** Folder for persisted policy state such as send counters; default CONFIG_DIR/state. */
  stateDir?: string;
}

export class AccountNotFoundError extends Error {
  constructor(requested: string, available: string[]) {
    super(`There is no mail account "${requested}". Available accounts: ${available.map((a) => `"${a}"`).join(", ")}.`);
    this.name = "AccountNotFoundError";
  }
}

/** A fresh SMTP connection per message, so credentials (and later OAuth tokens) are always current. */
function smtpTransport(account: AccountConfig, auth: AuthProvider): MailTransport {
  const smtp = account.smtp!;
  return {
    async sendMail(mail) {
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        ...smtpSecurityOptions(smtp.host, smtp.port, pinFromEndpoint(smtp)),
        auth: await auth.smtpAuth(),
      });
      try {
        return await transport.sendMail(mail);
      } finally {
        transport.close();
      }
    },
  };
}

function identitiesOf(account: AccountConfig): Identity[] {
  const configured = account.identities;
  const hasAccountEmail = configured.some((i) => i.email.toLowerCase() === account.email.toLowerCase());
  return hasAccountEmail ? configured : [...configured, { email: account.email }];
}

function createAccountRuntime(account: AccountConfig, secrets: SecretStore, deps: AppContextDeps): AccountRuntime {
  const auth = createAuthProvider(account, secrets);
  const manager = deps.connectImap ? null : new ImapConnectionManager(account.imap, auth, account.id);
  const getClient = deps.connectImap ? deps.connectImap(account) : () => manager!.getClient();
  const identities = identitiesOf(account);
  const ownAddresses = [...new Set(identities.map((i) => i.email.toLowerCase()))];
  let sendDeps: SendDeps | undefined;

  return {
    id: account.id,
    config: account,
    ownAddresses,
    policy: new PolicyEngine(account.id, account.policy, ownAddresses, {
      stateDir: deps.stateDir ?? path.join(CONFIG_DIR, "state"),
    }),
    getClient,
    getSendDeps() {
      if (!account.smtp) {
        throw new Error(`The mail account "${account.id}" has no outgoing (SMTP) server configured, so it cannot send. Run "${SERVER_NAME} setup" to add one.`);
      }
      sendDeps ??= {
        transport: deps.createTransport ? deps.createTransport(account) : smtpTransport(account, auth),
        getClient,
        imapHost: account.imap.host,
        sentCopy: account.sentCopy,
        sentProbeCache: new Map(),
        ...(deps.sentProbe ? { sentProbe: deps.sentProbe } : {}),
      };
      return sendDeps;
    },
    identityFor(from) {
      if (!from) return identities[0];
      const match = identities.find((i) => i.email.toLowerCase() === from.trim().toLowerCase());
      if (!match) {
        throw new Error(
          `"${from}" is not a sender address of the account "${account.id}". Allowed: ${identities.map((i) => i.email).join(", ")}.`,
        );
      }
      return match;
    },
    connectionStats() {
      return manager
        ? manager.stats
        : { connected: true, lastActivity: null, connectedSince: null, reconnectCount: 0, server: account.imap.host };
    },
    async shutdown() {
      await manager?.shutdown();
    },
  };
}

export function createAppContext(config: AppConfig, secrets: SecretStore, deps: AppContextDeps = {}): AppContext {
  const accounts = new Map<string, AccountRuntime>();
  for (const account of config.accounts) accounts.set(account.id, createAccountRuntime(account, secrets, deps));
  const defaultAccountId = config.defaultAccount ?? config.accounts[0].id;

  return {
    config,
    accounts,
    defaultAccountId,
    observers: [new InjectionRiskObserver(accounts)],
    secrets,
    resolveAccount(id) {
      const key = id?.trim() || defaultAccountId;
      const account = accounts.get(key);
      if (!account) throw new AccountNotFoundError(key, [...accounts.keys()]);
      return account;
    },
    anyAccountAllows(tier) {
      return [...accounts.values()].some((a) => tierAllowed(a.config, tier));
    },
    async shutdown() {
      const results = await Promise.allSettled([...accounts.values()].map((a) => a.shutdown()));
      for (const r of results) if (r.status === "rejected") log.warn("account.shutdown_failed", { error: String(r.reason) });
    },
  };
}
