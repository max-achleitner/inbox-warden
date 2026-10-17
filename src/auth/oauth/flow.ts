import { openBrowser as defaultOpenBrowser } from "./browser.js";
import { OAuthTokenError } from "./errors.js";
import { startLoopbackReceiver } from "./loopback.js";
import { createPkcePair, randomState } from "./pkce.js";
import { buildAuthorizeUrl, type OAuthProfile } from "./profiles.js";
import {
  exchangeAuthorizationCode,
  pollDeviceCode,
  requestDeviceCode,
  type TokenDeps,
  type TokenSet,
} from "./tokens.js";

export interface InteractiveAuthOptions {
  print(line: string): void;
  language?: "de" | "en";
  loginHint?: string;
  timeoutMs?: number;
  /** Opens the authorization URL; `false` = never try (headless/container), the URL is printed anyway. */
  openBrowser?: ((url: string) => Promise<boolean>) | false;
  /** Passed to the loopback receiver (see LoopbackOptions). */
  listenHost?: string;
  port?: number;
  /** Called with the authorization URL before the browser is opened (the sign_in tool returns it). */
  onAuthorizeUrl?(url: string): void;
  tokenDeps?: TokenDeps & { sleep?: (ms: number) => Promise<void> };
}

/** Sign-in result that is guaranteed to carry a refresh token. */
export type AuthorizedTokens = TokenSet & { refreshToken: string };

function requireRefreshToken(tokens: TokenSet, profile: OAuthProfile): AuthorizedTokens {
  if (!tokens.refreshToken) {
    throw new OAuthTokenError(
      "no_refresh_token",
      profile.provider === "google"
        ? "Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and sign in again."
        : "The sign-in server did not return a refresh token (offline_access missing).",
    );
  }
  return tokens as AuthorizedTokens;
}

/** Authorization code + PKCE with a loopback redirect (RFC 8252). */
export async function runLoopbackAuthorization(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens> {
  const de = opts.language === "de";
  const { verifier, challenge } = createPkcePair();
  const state = randomState();
  const receiver = await startLoopbackReceiver({
    state,
    redirectHost: profile.redirectHost,
    timeoutMs: opts.timeoutMs,
    language: opts.language,
    listenHost: opts.listenHost,
    port: opts.port,
  });
  try {
    const url = buildAuthorizeUrl(profile, {
      redirectUri: receiver.redirectUri,
      state,
      codeChallenge: challenge,
      loginHint: opts.loginHint,
    });
    opts.print(de ? "Bitte im Browser anmelden. Falls sich kein Fenster öffnet, diesen Link öffnen:" : "Please sign in in your browser. If no window opens, open this link:");
    opts.print(url);
    opts.onAuthorizeUrl?.(url);
    const opened = opts.openBrowser === false ? true : await (opts.openBrowser ?? defaultOpenBrowser)(url);
    if (!opened) opts.print(de ? "(Browser konnte nicht automatisch geöffnet werden.)" : "(The browser could not be opened automatically.)");
    const code = await receiver.waitForCode();
    const tokens = await exchangeAuthorizationCode(profile, { code, verifier, redirectUri: receiver.redirectUri }, opts.tokenDeps);
    return requireRefreshToken(tokens, profile);
  } finally {
    await receiver.close();
  }
}

/** Microsoft device code flow — fallback for machines without a usable browser. */
export async function runDeviceCodeAuthorization(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens> {
  const grant = await requestDeviceCode(profile, opts.tokenDeps);
  opts.print(
    opts.language === "de"
      ? `Öffnen Sie ${grant.verificationUri} und geben Sie den Code ${grant.userCode} ein.`
      : `Open ${grant.verificationUri} and enter the code ${grant.userCode}.`,
  );
  const tokens = await pollDeviceCode(profile, grant, opts.tokenDeps);
  return requireRefreshToken(tokens, profile);
}
