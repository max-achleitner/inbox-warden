import { ImapFlow } from "imapflow";
import { MissingPasswordError, type AuthProvider } from "./auth/provider.js";
import { OAuthConfigurationError, OAuthReauthRequiredError, OAuthSignInRequiredError, OAuthTokenError } from "./auth/oauth/errors.js";
import { ImapConnectionError } from "./errors.js";
import { imapSecurityOptions, pinFromEndpoint } from "./connection-security.js";
import * as log from "./logging/logger.js";
import { createProtocolLogger } from "./logging/protocol-log.js";
import { SERVER_NAME, VERSION } from "./version.js";

const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface ImapEndpoint {
  host: string;
  port: number;
  tlsFingerprint256?: string;
  tlsCertificatePem?: string;
}

export interface ConnectionStats {
  connected: boolean;
  lastActivity: Date | null;
  connectedSince: Date | null;
  reconnectCount: number;
  server: string;
}

function isAuthFailure(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { authenticationFailed?: boolean }).authenticationFailed === true;
}

/** Certificate problems: retrying meets the same certificate (or the same interceptor). */
const CERTIFICATE_ERROR_CODES = new Set([
  "ERR_CERT_PIN_MISMATCH",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Token endpoint answers that may succeed on the next attempt. */
const TRANSIENT_TOKEN_ERRORS = new Set(["temporarily_unavailable", "server_error", "http_error", "invalid_response"]);

function isCredentialProblem(err: unknown): boolean {
  if (
    err instanceof MissingPasswordError ||
    err instanceof OAuthSignInRequiredError ||
    err instanceof OAuthReauthRequiredError ||
    err instanceof OAuthConfigurationError
  ) {
    return true;
  }
  return err instanceof OAuthTokenError && !TRANSIENT_TOKEN_ERRORS.has(err.code);
}

function isCertificateProblem(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && CERTIFICATE_ERROR_CODES.has(code);
}

export class ImapConnectionManager {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private _stats: ConnectionStats;

  constructor(
    private readonly endpoint: ImapEndpoint,
    private readonly auth: AuthProvider,
    private readonly accountId: string,
  ) {
    this._stats = {
      connected: false,
      lastActivity: null,
      connectedSince: null,
      reconnectCount: 0,
      server: endpoint.host,
    };
  }

  get stats(): ConnectionStats {
    return { ...this._stats };
  }

  /** Get a usable IMAP client, connecting or reconnecting as needed */
  async getClient(): Promise<ImapFlow> {
    if (this.client && this.client.usable !== false) {
      this._stats.lastActivity = new Date();
      return this.client;
    }

    // Mutex: if already connecting, wait for it
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.connectWithRetry();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connectWithRetry(): Promise<ImapFlow> {
    let lastError: Error | undefined;
    let authRetried = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
          log.warn("imap.reconnecting", { account: this.accountId, attempt, delay, server: this.endpoint.host });
          await new Promise((resolve) => setTimeout(resolve, delay));
          this._stats.reconnectCount++;
        }

        const client = new ImapFlow({
          host: this.endpoint.host,
          port: this.endpoint.port,
          ...imapSecurityOptions(this.endpoint.host, this.endpoint.port, pinFromEndpoint(this.endpoint)),
          auth: await this.auth.imapAuth(),
          logger: createProtocolLogger(),
          clientInfo: { name: SERVER_NAME, version: VERSION },
        });

        // Set up event handlers before connecting
        client.on("close", () => {
          this._stats.connected = false;
          log.info("imap.disconnected", { account: this.accountId, server: this.endpoint.host });
          this.stopKeepAlive();
        });

        client.on("error", (err: Error) => {
          log.error("imap.error", { account: this.accountId, server: this.endpoint.host }, err);
        });

        await client.connect();

        // Clean up old client if any
        if (this.client) {
          try { this.client.close(); } catch { /* ignore */ }
        }

        this.client = client;
        this._stats.connected = true;
        this._stats.lastActivity = new Date();
        this._stats.connectedSince = new Date();

        log.info("imap.connected", {
          account: this.accountId,
          server: this.endpoint.host,
          attempt: attempt > 0 ? attempt + 1 : undefined,
        });

        this.startKeepAlive();
        return client;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.error("imap.connect_failed", {
          account: this.accountId,
          server: this.endpoint.host,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
        }, err);
        // Missing or revoked credentials and certificate problems: another attempt only adds delay
        if (isCredentialProblem(err)) throw err;
        if (isCertificateProblem(err)) {
          throw new ImapConnectionError(`Failed to connect to ${this.endpoint.host}: ${lastError.message}`, lastError);
        }
        if (isAuthFailure(err)) {
          // Never hammer the server with a wrong password (account lockouts): refresh once, then stop.
          await this.auth.invalidate();
          if (authRetried) {
            throw new ImapConnectionError(
              `Login to ${this.endpoint.host} was rejected. Check the password — many providers (Gmail, iCloud, Yahoo, GMX) require an app password.`,
              lastError,
            );
          }
          authRetried = true;
        }
      }
    }

    throw new ImapConnectionError(
      `Failed to connect to ${this.endpoint.host} after ${MAX_RETRIES} attempts: ${lastError?.message}`,
      lastError,
    );
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(async () => {
      if (this.client && this.client.usable !== false) {
        try {
          await this.client.noop();
          this._stats.lastActivity = new Date();
          log.debug("imap.keepalive", { account: this.accountId, server: this.endpoint.host });
        } catch {
          log.warn("imap.keepalive_failed", { account: this.accountId, server: this.endpoint.host });
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
    // Don't prevent process exit
    this.keepAliveTimer.unref();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /** Gracefully disconnect */
  async shutdown(): Promise<void> {
    this.stopKeepAlive();
    if (this.client) {
      try {
        await this.client.logout();
        log.info("imap.shutdown", { account: this.accountId, server: this.endpoint.host });
      } catch {
        try { this.client.close(); } catch { /* ignore */ }
      }
      this.client = null;
      this._stats.connected = false;
    }
  }
}
