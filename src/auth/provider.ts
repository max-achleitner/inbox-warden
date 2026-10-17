import type { AccountConfig } from "../config/schema.js";
import { secretEnvName, type SecretStore } from "../secrets/store.js";
import { OAuthAuthProvider } from "./oauth/provider.js";
import { SERVER_NAME } from "../version.js";

export type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };
export type SmtpAuth = { user: string; pass: string } | { type: "OAuth2"; user: string; accessToken: string };

export interface AuthProvider {
  imapAuth(): Promise<ImapAuth>;
  smtpAuth(): Promise<SmtpAuth>;
  /** Called after an authentication failure; OAuth providers refresh, password providers re-read the store. */
  invalidate(): Promise<void>;
}

/** No password is stored for an account; retrying cannot help until someone stores one. */
export class MissingPasswordError extends Error {
  constructor(readonly accountId: string) {
    super(
      `No password is stored for the mail account "${accountId}". Run "${SERVER_NAME} setup", or set ${secretEnvName(accountId, "password")}.`,
    );
    this.name = "MissingPasswordError";
  }
}

export class PasswordAuthProvider implements AuthProvider {
  private cached: string | null = null;

  constructor(private readonly account: AccountConfig, private readonly secrets: SecretStore) {}

  private get user(): string {
    return this.account.auth.username ?? this.account.email;
  }

  private async password(): Promise<string> {
    if (this.cached === null) {
      const value = await this.secrets.get(this.account.id, "password");
      if (!value) throw new MissingPasswordError(this.account.id);
      this.cached = value;
    }
    return this.cached;
  }

  async imapAuth(): Promise<ImapAuth> {
    return { user: this.user, pass: await this.password() };
  }

  async smtpAuth(): Promise<SmtpAuth> {
    return { user: this.user, pass: await this.password() };
  }

  async invalidate(): Promise<void> {
    this.cached = null;
  }
}

export function createAuthProvider(account: AccountConfig, secrets: SecretStore): AuthProvider {
  if (account.auth.type === "password") return new PasswordAuthProvider(account, secrets);
  return new OAuthAuthProvider(account, secrets);
}
