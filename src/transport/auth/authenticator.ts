import type { HttpAuthConfig } from "../../config/http-schema.js";
import { jsonResponse } from "../guards.js";
import { matchBearerToken, parseBearerHeader } from "./bearer.js";
import { bearerChallenge, protectedResourceMetadataUrl } from "./metadata.js";
import { AuthError, createJwtVerifier, type JwtVerifierDeps } from "./oauth.js";
import type { Principal } from "./principals.js";
import { SERVER_NAME } from "../../version.js";

export interface HttpAuthenticator {
  readonly mode: "bearer" | "oauth";
  /** Throws AuthError for missing/invalid credentials; other errors mean "auth backend unavailable". */
  authenticate(authorization: string | null): Promise<Principal>;
  /** 401 (or 403 for insufficient_scope) with an RFC 6750 WWW-Authenticate header. */
  challenge(error: AuthError): Response;
}

function challengeResponse(error: AuthError, params: Record<string, string | undefined>): Response {
  const status = error.code === "insufficient_scope" ? 403 : 401;
  // RFC 6750 §3.1: no error code when the request carried no credentials at all
  const withError = error.code === "invalid_request" ? params : { ...params, error: error.code, error_description: error.message, scope: error.scope };
  return jsonResponse(status, { error: error.code, error_description: error.message }, { "WWW-Authenticate": bearerChallenge(withError) });
}

export function createHttpAuthenticator(auth: HttpAuthConfig, publicUrl: string | undefined, deps: JwtVerifierDeps = {}): HttpAuthenticator {
  if (auth.mode === "bearer") {
    return {
      mode: "bearer",
      async authenticate(authorization) {
        const token = parseBearerHeader(authorization);
        if (!token) throw new AuthError("invalid_request", "Missing bearer token.");
        const tokenId = matchBearerToken(token, auth.tokens);
        if (!tokenId) throw new AuthError("invalid_token", "Unknown or revoked token.");
        return { kind: "bearer", id: `token:${tokenId}`, tokenId, groups: [], scopes: [] };
      },
      challenge: (error) => challengeResponse(error, { realm: SERVER_NAME }),
    };
  }

  if (!publicUrl) throw new Error("OAuth mode requires http.publicUrl.");
  const verify = createJwtVerifier(
    {
      issuer: auth.issuer,
      audience: auth.audience,
      jwksUri: auth.jwksUri,
      requiredScopes: auth.requiredScopes,
      clockToleranceSec: auth.clockToleranceSec,
      algorithms: auth.algorithms,
    },
    deps,
  );
  const resourceMetadata = protectedResourceMetadataUrl(publicUrl);
  return {
    mode: "oauth",
    async authenticate(authorization) {
      const token = parseBearerHeader(authorization);
      if (!token) throw new AuthError("invalid_request", "Missing bearer token.");
      return verify(token);
    },
    challenge: (error) => challengeResponse(error, { resource_metadata: resourceMetadata }),
  };
}
