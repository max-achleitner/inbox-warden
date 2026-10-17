import type { AccountConfig } from "../../config/schema.js";
import { OAuthConfigurationError } from "./errors.js";
import { SERVER_NAME } from "../../version.js";

/**
 * Owner decision O2: the "Application (client) ID" of the multi-tenant public client registered
 * for inbox-warden in Microsoft Entra ID. While undefined, every Microsoft account must set `auth.clientId`.
 * Deferred on 2026-10-17: Microsoft sign-in is a preview and stays bring-your-own-client-ID.
 */
export const MICROSOFT_DEFAULT_CLIENT_ID: string | undefined = undefined;

export const MICROSOFT_SCOPES = [
  "offline_access",
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
];
export const GOOGLE_SCOPES = ["https://mail.google.com/"];

export interface OAuthProfile {
  provider: "microsoft" | "google";
  authorizeUrl: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Microsoft registers "http://localhost" (any port); Google desktop clients use 127.0.0.1. */
  redirectHost: "localhost" | "127.0.0.1";
  extraAuthorizeParams: Record<string, string>;
}

export interface OAuthSettings {
  clientId?: string;
  clientSecret?: string;
  tenant?: string;
}

export function microsoftProfile(settings: OAuthSettings, defaultClientId = MICROSOFT_DEFAULT_CLIENT_ID): OAuthProfile {
  const clientId = settings.clientId ?? defaultClientId;
  if (!clientId) {
    throw new OAuthConfigurationError(
      "No Microsoft application (client) ID is configured for this account. " +
        `Ask your Microsoft 365 administrator for the client ID of the app registration for ${SERVER_NAME} ` +
        "and enter it in setup (it is stored as auth.clientId).",
    );
  }
  const tenant = settings.tenant ?? "organizations";
  if (!/^[A-Za-z0-9.-]+$/.test(tenant)) {
    throw new OAuthConfigurationError(`"${tenant}" is not a valid Microsoft tenant (use a domain, a tenant ID, "organizations" or "consumers").`);
  }
  const base = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  return {
    provider: "microsoft",
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    deviceCodeUrl: `${base}/devicecode`,
    clientId,
    scopes: MICROSOFT_SCOPES,
    redirectHost: "localhost",
    extraAuthorizeParams: { prompt: "select_account" },
  };
}

export function googleProfile(settings: OAuthSettings): OAuthProfile {
  if (!settings.clientId || !settings.clientSecret) {
    throw new OAuthConfigurationError(
      "Google sign-in needs your organisation's own OAuth client (client ID and client secret of a " +
        '"Desktop app" client of an Internal consent screen in Google Cloud). See docs/guide/providers.md. ' +
        "Personal Gmail accounts should use an app password instead.",
    );
  }
  return {
    provider: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    scopes: GOOGLE_SCOPES,
    redirectHost: "127.0.0.1",
    // offline + consent: Google only returns a refresh token when both are requested
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  };
}

export function profileFor(account: AccountConfig): OAuthProfile {
  if (account.auth.type !== "oauth2") {
    throw new OAuthConfigurationError(`Account "${account.id}" does not use OAuth sign-in.`);
  }
  return account.auth.provider === "microsoft" ? microsoftProfile(account.auth) : googleProfile(account.auth);
}

export function buildAuthorizeUrl(
  profile: OAuthProfile,
  params: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(profile.authorizeUrl);
  const query: Record<string, string> = {
    client_id: profile.clientId,
    response_type: "code",
    redirect_uri: params.redirectUri,
    scope: profile.scopes.join(" "),
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    ...profile.extraAuthorizeParams,
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}
