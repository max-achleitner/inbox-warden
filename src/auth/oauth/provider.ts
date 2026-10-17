import type { AccountConfig } from "../../config/schema.js";
import { errorMessage } from "../../errors.js";
import * as log from "../../logging/logger.js";
import type { SecretStore } from "../../secrets/store.js";
import type { AuthProvider, ImapAuth, SmtpAuth } from "../provider.js";
import { OAuthReauthRequiredError, OAuthSignInRequiredError, OAuthTokenError } from "./errors.js";
import { profileFor, type OAuthProfile } from "./profiles.js";
import { refreshAccessToken, type TokenDeps, type TokenSet } from "./tokens.js";

/** Refresh this long before the provider's expiry so a token never dies mid-command. */
export const EXPIRY_SKEW_MS = 2 * 60_000;

export class OAuthAuthProvider implements AuthProvider {
  private cached?: TokenSet;
  private refreshing?: Promise<TokenSet>;
  /** A rotated refresh token the store refused, and the stored token it replaces. */
  private unsaved?: { token: string; replaces: string };

  constructor(
    private readonly account: AccountConfig,
    private readonly secrets: SecretStore,
    private readonly deps: TokenDeps & { profile?: OAuthProfile } = {},
  ) {}

  get username(): string {
    return (this.account.auth.type === "oauth2" ? this.account.auth.username : undefined) ?? this.account.email;
  }

  async accessToken(): Promise<string> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && this.cached.expiresAt - EXPIRY_SKEW_MS > now) return this.cached.accessToken;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = undefined;
    });
    return (await this.refreshing).accessToken;
  }

  private async refresh(): Promise<TokenSet> {
    // Resolved lazily: a missing client id becomes a tool error, not a server crash at startup.
    const profile = this.deps.profile ?? profileFor(this.account);
    const stored = await this.secrets.get(this.account.id, "oauthRefreshToken");
    // An unsaved rotated token is newer, unless a sign-in has replaced the stored one since
    const refreshToken = this.unsaved && this.unsaved.replaces === stored ? this.unsaved.token : stored;
    if (!refreshToken) throw new OAuthSignInRequiredError(this.account.id);

    let tokens: TokenSet;
    try {
      tokens = await refreshAccessToken(profile, refreshToken, this.deps);
    } catch (err) {
      if (err instanceof OAuthTokenError && (err.code === "invalid_grant" || err.code === "interaction_required")) {
        throw new OAuthReauthRequiredError(this.account.id, err.description ?? err.code);
      }
      throw err;
    }
    // Microsoft rotates refresh tokens; keep the newest one or the next restart fails.
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      try {
        await this.secrets.set(this.account.id, "oauthRefreshToken", tokens.refreshToken);
        this.unsaved = undefined;
      } catch (err) {
        // The new access token is valid either way: keep working and use the newest refresh token from memory
        this.unsaved = { token: tokens.refreshToken, replaces: stored ?? "" };
        log.warn("oauth.refresh_token_not_saved", { account: this.account.id, error: errorMessage(err) });
      }
    }
    this.cached = tokens;
    return tokens;
  }

  async imapAuth(): Promise<ImapAuth> {
    return { user: this.username, accessToken: await this.accessToken() };
  }

  async smtpAuth(): Promise<SmtpAuth> {
    return { type: "OAuth2", user: this.username, accessToken: await this.accessToken() };
  }

  /** Plan 2's ImapConnectionManager calls this after a rejected login and retries once. */
  async invalidate(): Promise<void> {
    this.cached = undefined;
  }
}
