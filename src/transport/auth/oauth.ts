import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Principal } from "./principals.js";

export interface OAuthSettings {
  issuer: string;
  audience: string[];
  jwksUri?: string;
  requiredScopes: string[];
  clockToleranceSec: number;
  algorithms: string[];
}

export class AuthError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_token" | "insufficient_scope",
    message: string,
    readonly scope?: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** RFC 8414 location: the well-known segment goes between host and issuer path. */
export function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

export function openIdConfigurationUrl(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
}

/** Find jwks_uri via OIDC discovery, then RFC 8414. The document's issuer must match exactly. */
export async function discoverJwksUri(issuer: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  for (const url of [openIdConfigurationUrl(issuer), authorizationServerMetadataUrl(issuer)]) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const doc = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
      if (doc.issuer === issuer && typeof doc.jwks_uri === "string") return doc.jwks_uri;
    } catch {
      // try the next discovery location
    }
  }
  throw new Error(`Could not discover the signing keys of ${issuer}. Set httpAuth.jwksUri explicitly.`);
}

/** Scopes from `scope`/`scp` (space-separated string or array) plus Entra app `roles`. */
export function tokenScopes(payload: JWTPayload): string[] {
  const scopes = new Set<string>();
  for (const claim of ["scope", "scp"]) {
    const value = payload[claim];
    if (typeof value === "string") value.split(" ").filter(Boolean).forEach((s) => scopes.add(s));
    else if (Array.isArray(value)) value.forEach((s) => typeof s === "string" && scopes.add(s));
  }
  const roles = payload.roles;
  if (Array.isArray(roles)) roles.forEach((r) => typeof r === "string" && scopes.add(r));
  return [...scopes];
}

function firstString(payload: JWTPayload, claims: string[]): string | undefined {
  for (const claim of claims) {
    const value = payload[claim];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The caller's address for principal rules — only when the IdP vouches for it: `email` with
 * `email_verified` (OIDC) or Entra's `xms_edov`, else Entra's tenant-assigned `upn` for members.
 * `preferred_username` and unverified `email` can be set by users or guests and are ignored.
 */
function verifiedEmail(payload: JWTPayload): string | undefined {
  const email = firstString(payload, ["email"]);
  if (email && (payload.email_verified === true || payload.xms_edov === true)) return email;
  const upn = firstString(payload, ["upn"]);
  if (upn && upn.includes("@") && !upn.includes("#EXT#")) return upn;
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function describe(err: unknown): string {
  const code = (err as { code?: string }).code;
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return "The access token has expired.";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      return "The access token was issued for a different server or issuer.";
    case "ERR_JWKS_NO_MATCHING_KEY":
      return "The access token was signed with an unknown key.";
    default:
      return "The access token is invalid.";
  }
}

export interface JwtVerifierDeps {
  /** Injected key resolver (tests: jose createLocalJWKSet). */
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
}

/**
 * Validate access tokens issued by an external IdP (Entra ID, Google, Keycloak, …).
 * Throws AuthError for token problems; other errors (IdP unreachable) propagate as-is.
 */
export function createJwtVerifier(settings: OAuthSettings, deps: JwtVerifierDeps = {}) {
  let keys = deps.keys;
  async function getKeys(): Promise<JWTVerifyGetKey> {
    if (!keys) {
      const uri = settings.jwksUri ?? (await discoverJwksUri(settings.issuer, deps.fetch));
      keys = createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000 });
    }
    return keys;
  }

  return async function verify(token: string): Promise<Principal> {
    const resolver = await getKeys();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, resolver, {
        issuer: settings.issuer,
        audience: settings.audience,
        clockTolerance: settings.clockToleranceSec,
        algorithms: settings.algorithms,
        requiredClaims: ["exp", "sub"],
      }));
    } catch (err) {
      // The key server being down or slow says nothing about the token: let it surface as "unavailable" (503)
      if (!(err instanceof errors.JOSEError) || err.code === "ERR_JWKS_TIMEOUT" || err.code === "ERR_JOSE_GENERIC") throw err;
      throw new AuthError("invalid_token", describe(err));
    }
    const scopes = tokenScopes(payload);
    const missing = settings.requiredScopes.filter((s) => !scopes.includes(s));
    if (missing.length > 0) {
      throw new AuthError("insufficient_scope", `The access token lacks the scope(s): ${missing.join(" ")}.`, settings.requiredScopes.join(" "));
    }
    return {
      kind: "oauth",
      id: `oauth:${payload.sub}`,
      sub: payload.sub,
      email: verifiedEmail(payload),
      groups: stringArray(payload.groups),
      scopes,
      clientId: firstString(payload, ["azp", "appid", "client_id"]),
      expiresAt: payload.exp,
    };
  };
}
