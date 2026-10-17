import type { AccountConfig } from "../../config/schema.js";
import { errorMessage } from "../../errors.js";
import type { SecretStore } from "../../secrets/store.js";
import { OAuthTokenError } from "./errors.js";
import { runLoopbackAuthorization, type AuthorizedTokens, type InteractiveAuthOptions } from "./flow.js";
import { profileFor, type OAuthProfile } from "./profiles.js";
import { refreshAccessToken, type TokenDeps } from "./tokens.js";

/** A browser sign-in started from the server stays open this long. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export type SignInStatus =
  | { state: "not_needed" }
  | { state: "signed_in" }
  | { state: "waiting"; url: string; expiresAt: number }
  | { state: "failed"; error: string };

export interface SignInDeps {
  secrets: SecretStore;
  authorize?(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens>;
  openBrowser?(url: string): Promise<boolean>;
  tokenDeps?: TokenDeps;
  now?(): number;
}

interface PendingSignIn {
  url: string;
  expiresAt: number;
  finished: Promise<void>;
  outcome?: { ok: true } | { ok: false; error: Error };
}

function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Browser sign-in started from the MCP server process, for users who never run the CLI
 * (Claude Desktop bundle). One sign_in tool call waits a bounded time; the flow keeps running
 * in the background for up to five minutes and a later call picks up the result.
 */
export class SignInManager {
  private readonly pending = new Map<string, PendingSignIn>();

  constructor(private readonly deps: SignInDeps) {}

  async signIn(account: AccountConfig, waitMs: number): Promise<SignInStatus> {
    if (account.auth.type !== "oauth2") return { state: "not_needed" };

    let flow = this.pending.get(account.id);
    if (!flow) {
      if (await this.hasWorkingSignIn(account)) return { state: "signed_in" };
      flow = await this.start(account);
    }

    await waitAtMost(flow.finished, waitMs);
    if (!flow.outcome) return { state: "waiting", url: flow.url, expiresAt: flow.expiresAt };
    this.pending.delete(account.id);
    return flow.outcome.ok ? { state: "signed_in" } : { state: "failed", error: flow.outcome.error.message };
  }

  /** A stored refresh token that the provider still accepts. */
  private async hasWorkingSignIn(account: AccountConfig): Promise<boolean> {
    const refreshToken = await this.deps.secrets.get(account.id, "oauthRefreshToken");
    if (!refreshToken) return false;
    try {
      const tokens = await refreshAccessToken(profileFor(account), refreshToken, this.deps.tokenDeps);
      if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
        await this.deps.secrets.set(account.id, "oauthRefreshToken", tokens.refreshToken);
      }
      return true;
    } catch (err) {
      if (err instanceof OAuthTokenError && (err.code === "invalid_grant" || err.code === "interaction_required")) return false;
      throw err;
    }
  }

  private start(account: AccountConfig): Promise<PendingSignIn> {
    const profile = profileFor(account); // a missing client id throws here → tool error with instructions
    const now = (this.deps.now ?? Date.now)();
    const authorize = this.deps.authorize ?? runLoopbackAuthorization;
    return new Promise<PendingSignIn>((resolveStarted, rejectStarted) => {
      const flow: PendingSignIn = { url: "", expiresAt: now + SIGN_IN_TIMEOUT_MS, finished: Promise.resolve() };
      flow.finished = authorize(profile, {
        print: () => {}, // the URL travels in the tool result instead
        language: account.locale,
        loginHint: account.email,
        timeoutMs: SIGN_IN_TIMEOUT_MS,
        openBrowser: this.deps.openBrowser,
        tokenDeps: this.deps.tokenDeps,
        onAuthorizeUrl: (url) => {
          flow.url = url;
          this.pending.set(account.id, flow);
          resolveStarted(flow);
        },
      }).then(
        async (tokens) => {
          // Never let this handler reject: a flow without an outcome would block every later sign_in
          try {
            await this.deps.secrets.set(account.id, "oauthRefreshToken", tokens.refreshToken);
            flow.outcome = { ok: true };
          } catch (err) {
            flow.outcome = {
              ok: false,
              error: new Error(
                `The sign-in worked, but the sign-in token could not be saved: ${errorMessage(err)}. ` +
                  "Make sure the keychain (or IMAP_MCP_STATE_KEY in a container) is available, then sign in again.",
              ),
            };
          }
        },
        (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          flow.outcome = { ok: false, error };
          rejectStarted(error); // only matters when the flow failed before the URL existed
        },
      );
    });
  }
}
