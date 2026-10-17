import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, createLocalJWKSet, errors, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import {
  AuthError,
  authorizationServerMetadataUrl,
  createJwtVerifier,
  discoverJwksUri,
  type OAuthSettings,
} from "../auth/oauth.js";
import {
  bearerChallenge,
  buildProtectedResourceMetadata,
  isProtectedResourceMetadataPath,
  protectedResourceMetadataUrl,
} from "../auth/metadata.js";

const ISSUER = "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0";
const API_GUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const settings: OAuthSettings = {
  issuer: ISSUER,
  audience: [API_GUID, `api://${API_GUID}`],
  requiredScopes: ["mail.access"],
  clockToleranceSec: 60,
  algorithms: ["RS256", "PS256", "ES256"],
};

let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;

async function token(claims: Record<string, unknown>, opts: { aud?: string; exp?: string; kid?: string; iss?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: opts.kid ?? "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? API_GUID)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey as CryptoKey;
  const jwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "k1", alg: "ES256" }] });
});

describe("createJwtVerifier", () => {
  it("accepts an Entra-style token (scp claim, GUID audience) and builds the principal", async () => {
    const verify = createJwtVerifier(settings, { keys });
    const principal = await verify(await token({ scp: "mail.access other", upn: "Max@Firma.example", groups: ["g-mail"], azp: "client-1" }));
    expect(principal).toMatchObject({
      kind: "oauth",
      id: "oauth:user-1",
      email: "Max@Firma.example",
      groups: ["g-mail"],
      clientId: "client-1",
    });
    expect(principal.scopes).toEqual(["mail.access", "other"]);
  });

  describe("only verified addresses become the principal's email (mailbox rules match on it)", () => {
    it.each([
      ["an unverified email claim", { email: "ceo@company.com" }],
      ["email_verified false", { email: "ceo@company.com", email_verified: false }],
      ["preferred_username (user-editable)", { preferred_username: "ceo@company.com" }],
      ["a guest UPN", { upn: "ceo_company.com#EXT#@tenant.onmicrosoft.com" }],
    ])("ignores %s", async (_name, claims) => {
      const verify = createJwtVerifier(settings, { keys });
      expect((await verify(await token({ scp: "mail.access", ...claims }))).email).toBeUndefined();
    });

    it.each([
      ["email_verified", { email: "max@company.com", email_verified: true }],
      ["Entra's verified domain owner flag", { email: "max@company.com", xms_edov: true }],
      ["a member UPN", { upn: "max@company.com" }],
    ])("accepts %s", async (_name, claims) => {
      const verify = createJwtVerifier(settings, { keys });
      expect((await verify(await token({ scp: "mail.access", ...claims }))).email).toBe("max@company.com");
    });
  });

  it("accepts the api:// audience form and app roles", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify(await token({ roles: ["mail.access"] }, { aud: `api://${API_GUID}` }))).resolves.toMatchObject({ sub: "user-1" });
  });

  it("rejects a token for another audience as invalid_token", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify(await token({ scp: "mail.access" }, { aud: "https://graph.microsoft.com" }))).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects an expired token and an unknown key id with invalid_token, not a crash", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify(await token({ scp: "mail.access" }, { exp: "-10m" }))).rejects.toMatchObject({ code: "invalid_token", message: expect.stringMatching(/expired/) });
    await expect(verify(await token({ scp: "mail.access" }, { kid: "rotated" }))).rejects.toBeInstanceOf(AuthError);
  });

  it("reports missing scopes as insufficient_scope", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify(await token({ scp: "other" }))).rejects.toMatchObject({ code: "insufficient_scope", scope: "mail.access" });
  });

  it("rejects garbage", async () => {
    const verify = createJwtVerifier(settings, { keys });
    await expect(verify("not.a.jwt")).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("passes an unreachable or slow key server through as unavailable, not as a bad token", async () => {
    const valid = await token({ scp: "mail.access" });
    const failures = [new errors.JWKSTimeout(), new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response"), new TypeError("fetch failed")];
    for (const failure of failures) {
      const verify = createJwtVerifier(settings, { keys: async () => { throw failure; } });
      const outcome = await verify(valid).catch((err: unknown) => err);
      expect(outcome).toBe(failure);
      expect(outcome).not.toBeInstanceOf(AuthError);
    }
  });
});

describe("discoverJwksUri", () => {
  it("uses OIDC discovery and requires the issuer to match", async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith("/openid-configuration")
        ? new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: "https://login.microsoftonline.com/keys" }))
        : new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await discoverJwksUri(ISSUER, fetchImpl)).toBe("https://login.microsoftonline.com/keys");
  });

  it("fails clearly when no document matches", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ issuer: "https://evil.example", jwks_uri: "x" }))) as unknown as typeof fetch;
    await expect(discoverJwksUri(ISSUER, fetchImpl)).rejects.toThrow(/httpAuth\.jwksUri/);
  });

  it("builds the RFC 8414 location with the issuer path appended", () => {
    expect(authorizationServerMetadataUrl("https://idp.example/realms/kmu")).toBe(
      "https://idp.example/.well-known/oauth-authorization-server/realms/kmu",
    );
  });
});

describe("protected resource metadata", () => {
  it("builds the RFC 9728 document and the path-aware URL", () => {
    expect(buildProtectedResourceMetadata({ publicUrl: "https://mail.example.com", issuer: ISSUER, scopes: ["mail.access"] })).toEqual({
      resource: "https://mail.example.com/mcp",
      authorization_servers: [ISSUER],
      scopes_supported: ["mail.access"],
      bearer_methods_supported: ["header"],
      resource_name: "inbox-warden",
    });
    expect(protectedResourceMetadataUrl("https://mail.example.com")).toBe(
      "https://mail.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(isProtectedResourceMetadataPath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isProtectedResourceMetadataPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
  });

  it("formats WWW-Authenticate challenges and strips quotes", () => {
    expect(bearerChallenge({ resource_metadata: "https://x/.well-known/oauth-protected-resource/mcp", error: "invalid_token", error_description: 'bad "token"' })).toBe(
      'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="bad token"',
    );
    expect(bearerChallenge({})).toBe("Bearer");
  });
});
