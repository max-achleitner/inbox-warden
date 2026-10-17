import { describe, it, expect } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { HttpAuthSchema } from "../../config/http-schema.js";
import { createHttpAuthenticator } from "../auth/authenticator.js";
import { generateBearerToken } from "../auth/bearer.js";
import { AuthError } from "../auth/oauth.js";

describe("bearer authenticator", () => {
  const { token, sha256 } = generateBearerToken();
  const auth = createHttpAuthenticator(HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "laptop", sha256 }] }), undefined);

  it("maps a valid token to a bearer principal", async () => {
    expect(await auth.authenticate(`Bearer ${token}`)).toEqual({ kind: "bearer", id: "token:laptop", tokenId: "laptop", groups: [], scopes: [] });
  });

  it("distinguishes missing credentials from bad ones", async () => {
    await expect(auth.authenticate(null)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(auth.authenticate("Bearer imcp_nope")).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("omits the error code when no credentials were sent (RFC 6750 §3.1)", () => {
    const res = auth.challenge(new AuthError("invalid_request", "Missing bearer token."));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="inbox-warden"');
  });
});

describe("OAuth authenticator", () => {
  it("challenges with resource_metadata and maps insufficient_scope to 403", async () => {
    const pair = await generateKeyPair("ES256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "ES256" }] });
    const config = HttpAuthSchema.parse({
      mode: "oauth",
      issuer: "https://idp.example",
      audience: "api",
      requiredScopes: ["mail.access"],
      principals: [{ match: { sub: "u" }, accounts: ["main"] }],
    });
    const auth = createHttpAuthenticator(config, "https://mail.example.com", { keys });

    const missing = auth.challenge(new AuthError("invalid_request", "Missing bearer token."));
    expect(missing.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://mail.example.com/.well-known/oauth-protected-resource/mcp"');

    const jwt = await new SignJWT({ scope: "profile" })
      .setProtectedHeader({ alg: "ES256", kid: "k" })
      .setIssuer("https://idp.example")
      .setAudience("api")
      .setSubject("u")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    const error = await auth.authenticate(`Bearer ${jwt}`).catch((e: AuthError) => e);
    expect(error).toBeInstanceOf(AuthError);
    const res = auth.challenge(error as AuthError);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(res.headers.get("www-authenticate")).toContain('scope="mail.access"');
  });

  it("refuses to build without a publicUrl", () => {
    const config = HttpAuthSchema.parse({ mode: "oauth", issuer: "https://idp.example", audience: "api", principals: [{ match: { sub: "u" }, accounts: ["main"] }] });
    expect(() => createHttpAuthenticator(config, undefined)).toThrow(/publicUrl/);
  });
});
