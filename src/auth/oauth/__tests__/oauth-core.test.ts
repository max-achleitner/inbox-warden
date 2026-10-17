import { describe, it, expect } from "vitest";
import { challengeFor, createPkcePair, randomState } from "../pkce.js";
import { buildAuthorizeUrl, googleProfile, microsoftProfile } from "../profiles.js";
import { OAuthConfigurationError, OAuthTimeoutError, OAuthTokenError } from "../errors.js";
import {
  exchangeAuthorizationCode,
  pollDeviceCode,
  refreshAccessToken,
  requestDeviceCode,
  type FetchLike,
} from "../tokens.js";

/** Scripted token endpoint: each call pops the next [status, body] and records the request. */
function scriptedFetch(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; params: URLSearchParams }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, params: new URLSearchParams(init.body) });
    const [status, body] = responses.shift() ?? [500, {}];
    return { status, json: async () => body };
  };
  return { fetch, calls };
}

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates url-safe verifiers and states", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(challengeFor(verifier));
    expect(randomState()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("profiles", () => {
  it("builds the Microsoft profile for the organizations endpoint by default", () => {
    const p = microsoftProfile({ clientId: "11111111-2222-3333-4444-555555555555" });
    expect(p.tokenUrl).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
    expect(p.scopes).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(p.scopes).toContain("offline_access");
  });

  it("asks for a client id when none is configured", () => {
    expect(() => microsoftProfile({}, undefined)).toThrow(OAuthConfigurationError);
    expect(() => microsoftProfile({}, undefined)).toThrow(/client\) ID/);
  });

  it("rejects tenants that could alter the URL", () => {
    expect(() => microsoftProfile({ clientId: "x", tenant: "evil.com/../" })).toThrow(OAuthConfigurationError);
  });

  it("requires Google client id and secret", () => {
    expect(() => googleProfile({ clientId: "abc" })).toThrow(/client secret/);
  });

  it("puts PKCE, state and login hint into the authorize URL", () => {
    const p = googleProfile({ clientId: "cid", clientSecret: "sec" });
    const url = new URL(buildAuthorizeUrl(p, { redirectUri: "http://127.0.0.1:5000", state: "st", codeChallenge: "ch", loginHint: "a@b.c" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      response_type: "code",
      code_challenge: "ch",
      code_challenge_method: "S256",
      state: "st",
      access_type: "offline",
      prompt: "consent",
      login_hint: "a@b.c",
      scope: "https://mail.google.com/",
    });
    expect(url.searchParams.has("client_secret")).toBe(false);
  });
});

describe("token endpoint client", () => {
  const ms = microsoftProfile({ clientId: "cid" });

  it("exchanges an authorization code with the PKCE verifier", async () => {
    const { fetch, calls } = scriptedFetch([[200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }]]);
    const tokens = await exchangeAuthorizationCode(ms, { code: "c0de", verifier: "v", redirectUri: "http://localhost:4000" }, { fetch, now: () => 1000 });
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1000 + 3_600_000, scope: undefined });
    expect(Object.fromEntries(calls[0].params)).toMatchObject({ grant_type: "authorization_code", code: "c0de", code_verifier: "v", client_id: "cid" });
    expect(calls[0].params.has("client_secret")).toBe(false);
  });

  it("sends the Google client secret on refresh", async () => {
    const google = googleProfile({ clientId: "cid", clientSecret: "sec" });
    const { fetch, calls } = scriptedFetch([[200, { access_token: "at2", expires_in: "3599" }]]);
    const tokens = await refreshAccessToken(google, "rt", { fetch, now: () => 0 });
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBeUndefined();
    expect(calls[0].params.get("client_secret")).toBe("sec");
  });

  it("surfaces RFC 6749 error codes", async () => {
    const { fetch } = scriptedFetch([[400, { error: "invalid_grant", error_description: "AADSTS70000: revoked" }]]);
    await expect(refreshAccessToken(ms, "rt", { fetch })).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects malformed success answers", async () => {
    const { fetch } = scriptedFetch([[200, { token: "nope" }]]);
    await expect(refreshAccessToken(ms, "rt", { fetch })).rejects.toBeInstanceOf(OAuthTokenError);
  });
});

describe("device code flow (Microsoft fallback)", () => {
  const ms = microsoftProfile({ clientId: "cid" });

  it("polls through authorization_pending and slow_down", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const { fetch } = scriptedFetch([
      [200, { device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 }],
      [400, { error: "authorization_pending" }],
      [400, { error: "slow_down" }],
      [200, { access_token: "at", refresh_token: "rt", expires_in: 3600 }],
    ]);
    const grant = await requestDeviceCode(ms, { fetch, now: () => clock });
    expect(grant.userCode).toBe("ABCD-EFGH");
    const tokens = await pollDeviceCode(ms, grant, {
      fetch,
      now: () => clock,
      sleep: async (msDelay) => {
        sleeps.push(msDelay);
        clock += msDelay;
      },
    });
    expect(tokens.refreshToken).toBe("rt");
    expect(sleeps).toEqual([5000, 5000, 10000]);
  });

  it("times out when the code expires", async () => {
    let clock = 0;
    const { fetch } = scriptedFetch([[400, { error: "authorization_pending" }], [400, { error: "expired_token" }]]);
    const grant = { deviceCode: "dc", userCode: "X", verificationUri: "https://microsoft.com/devicelogin", intervalMs: 1000, expiresAt: 60_000 };
    await expect(
      pollDeviceCode(ms, grant, { fetch, now: () => clock, sleep: async (d) => { clock += d; } }),
    ).rejects.toBeInstanceOf(OAuthTimeoutError);
  });
});
