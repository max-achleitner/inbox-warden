import { z } from "zod";
import { OAuthAuthorizationError, OAuthConfigurationError, OAuthTimeoutError, OAuthTokenError } from "./errors.js";
import type { OAuthProfile } from "./profiles.js";

/** The subset of fetch() used here, injectable for tests. */
export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
}

export interface TokenDeps {
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive(),
  scope: z.string().optional(),
});

const ErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.coerce.number().positive(),
  interval: z.coerce.number().positive().optional(),
  message: z.string().optional(),
});

async function postForm(url: string, params: Record<string, string>, deps: TokenDeps): Promise<unknown> {
  const doFetch = deps.fetch ?? (fetch as unknown as FetchLike);
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const error = ErrorResponseSchema.safeParse(json);
  if (error.success) throw new OAuthTokenError(error.data.error, error.data.error_description);
  if (res.status >= 400) throw new OAuthTokenError("http_error", `The sign-in server answered HTTP ${res.status}.`);
  return json;
}

function toTokenSet(json: unknown, now: number): TokenSet {
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new OAuthTokenError("invalid_response", "The sign-in server returned an unexpected answer.");
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: now + parsed.data.expires_in * 1000,
    scope: parsed.data.scope,
  };
}

function clientParams(profile: OAuthProfile): Record<string, string> {
  return { client_id: profile.clientId, ...(profile.clientSecret ? { client_secret: profile.clientSecret } : {}) };
}

export async function exchangeAuthorizationCode(
  profile: OAuthProfile,
  input: { code: string; verifier: string; redirectUri: string },
  deps: TokenDeps = {},
): Promise<TokenSet> {
  const json = await postForm(
    profile.tokenUrl,
    {
      ...clientParams(profile),
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      scope: profile.scopes.join(" "),
    },
    deps,
  );
  return toTokenSet(json, (deps.now ?? Date.now)());
}

export async function refreshAccessToken(profile: OAuthProfile, refreshToken: string, deps: TokenDeps = {}): Promise<TokenSet> {
  const json = await postForm(
    profile.tokenUrl,
    { ...clientParams(profile), grant_type: "refresh_token", refresh_token: refreshToken, scope: profile.scopes.join(" ") },
    deps,
  );
  return toTokenSet(json, (deps.now ?? Date.now)());
}

export interface DeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  message?: string;
  intervalMs: number;
  expiresAt: number;
}

export async function requestDeviceCode(profile: OAuthProfile, deps: TokenDeps = {}): Promise<DeviceCodeGrant> {
  if (!profile.deviceCodeUrl) {
    throw new OAuthConfigurationError(`Sign-in with a code is not available for ${profile.provider}; use the browser sign-in.`);
  }
  const json = await postForm(profile.deviceCodeUrl, { client_id: profile.clientId, scope: profile.scopes.join(" ") }, deps);
  const parsed = DeviceCodeResponseSchema.safeParse(json);
  if (!parsed.success) throw new OAuthTokenError("invalid_response", "The sign-in server returned an unexpected answer.");
  const now = (deps.now ?? Date.now)();
  return {
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    message: parsed.data.message,
    intervalMs: (parsed.data.interval ?? 5) * 1000,
    expiresAt: now + parsed.data.expires_in * 1000,
  };
}

export async function pollDeviceCode(
  profile: OAuthProfile,
  grant: DeviceCodeGrant,
  deps: TokenDeps & { sleep?: (ms: number) => Promise<void> } = {},
): Promise<TokenSet> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let interval = grant.intervalMs;
  while (now() < grant.expiresAt) {
    await sleep(interval);
    try {
      const json = await postForm(
        profile.tokenUrl,
        { client_id: profile.clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: grant.deviceCode },
        deps,
      );
      return toTokenSet(json, now());
    } catch (err) {
      if (!(err instanceof OAuthTokenError)) throw err;
      if (err.code === "authorization_pending") continue;
      if (err.code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (err.code === "expired_token") break;
      if (err.code === "authorization_declined" || err.code === "access_denied") throw new OAuthAuthorizationError("access_denied");
      throw err;
    }
  }
  throw new OAuthTimeoutError("Sign-in with a code");
}
