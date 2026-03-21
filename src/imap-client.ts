import { ImapFlow } from "imapflow";
import type { Credentials } from "./credentials.js";
import { ImapConnectionError } from "./errors.js";
import * as log from "./logging/logger.js";

const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface ConnectionStats {
  connected: boolean;
  lastActivity: Date | null;
  connectedSince: Date | null;
  reconnectCount: number;
  server: string;
}

export class ImapConnectionManager {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private _stats: ConnectionStats;
  private creds: Credentials;

  constructor(creds: Credentials) {
    this.creds = creds;
    this._stats = {
      connected: false,
      lastActivity: null,
      connectedSince: null,
      reconnectCount: 0,
      server: creds.imapHost,
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
      const client = await this.connecting;
      return client;
    } finally {
      this.connecting = null;
    }
  }

  private async connectWithRetry(): Promise<ImapFlow> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
          log.warn("imap.reconnecting", { attempt, delay, server: this.creds.imapHost });
          await new Promise((resolve) => setTimeout(resolve, delay));
          this._stats.reconnectCount++;
        }

        const client = new ImapFlow({
          host: this.creds.imapHost,
          port: this.creds.imapPort,
          secure: this.creds.imapPort === 993,
          auth: {
            user: this.creds.user,
            pass: this.creds.password,
          },
          logger: false,
        });

        // Set up event handlers before connecting
        client.on("close", () => {
          this._stats.connected = false;
          log.info("imap.disconnected", { server: this.creds.imapHost });
          this.stopKeepAlive();
        });

        client.on("error", (err: Error) => {
          log.error("imap.error", { server: this.creds.imapHost }, err);
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
          server: this.creds.imapHost,
          user: this.creds.user,
          attempt: attempt > 0 ? attempt + 1 : undefined,
        });

        this.startKeepAlive();
        return client;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.error("imap.connect_failed", {
          server: this.creds.imapHost,
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
        }, err);
      }
    }

    throw new ImapConnectionError(
      `Failed to connect to ${this.creds.imapHost} after ${MAX_RETRIES} attempts: ${lastError?.message}`,
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
          log.debug("imap.keepalive", { server: this.creds.imapHost });
        } catch {
          log.warn("imap.keepalive_failed", { server: this.creds.imapHost });
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
        log.info("imap.shutdown", { server: this.creds.imapHost });
      } catch {
        try { this.client.close(); } catch { /* ignore */ }
      }
      this.client = null;
      this._stats.connected = false;
    }
  }
}
