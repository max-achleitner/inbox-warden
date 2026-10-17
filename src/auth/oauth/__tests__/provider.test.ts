import { describe, it, expect } from "vitest";
import { MemorySecretStore } from "../../../secrets/memory-store.js";
import { AccountSchema } from "../../../config/schema.js";
import { OAuthConfigurationError, OAuthReauthRequiredError, OAuthSignInRequiredError } from "../errors.js";
import { OAuthAuthProvider } from "../provider.js";
import type { FetchLike } from "../tokens.js";

const account = AccountSchema.parse({
  id: "work",
  email: "max@firma.at",
  imap: { host: "outlook.office365.com", port: 993 },
  smtp: { host: "smtp.office365.com", port: 587 },
  auth: { type: "oauth2", provider: "microsoft", clientId: "cid" },
});

function tokenEndpoint(responses: Array<[number, unknown]>) {
  let calls = 0;
  const fetch: FetchLike = async () => {
    calls++;
    const [status, body] = responses.shift() ?? [500, {}];
    return { status, json: async () => body };
  };
  return { fetch, calls: () => calls };
}

describe("OAuthAuthProvider", () => {
  it("refreshes once, caches the access token and stores a rotated refresh token", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt-1");
    const ep = tokenEndpoint([[200, { access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 }]]);
    let clock = 0;
    const provider = new OAuthAuthProvider(account, secrets, { fetch: ep.fetch, now: () => clock });

    expect(await provider.imapAuth()).toEqual({ user: "max@firma.at", accessToken: "at-1" });
    clock = 30 * 60_000;
    expect(await provider.smtpAuth()).toEqual({ type: "OAuth2", user: "max@firma.at", accessToken: "at-1" });
    expect(ep.calls()).toBe(1);
    expect(await secrets.get("work", "oauthRefreshToken")).toBe("rt-2");
  });

  it("keeps working when the rotated refresh token cannot be stored, using it from memory", async () => {
    const memory = new MemorySecretStore();
    await memory.set("work", "oauthRefreshToken", "rt-1");
    const secrets = {
      get: memory.get.bind(memory),
      set: async () => {
        throw new Error("Cannot store secrets in container mode without a state key");
      },
      delete: memory.delete.bind(memory),
    };
    const responses = [
      { access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 },
      { access_token: "at-2", refresh_token: "rt-3", expires_in: 3600 },
    ];
    const used: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      used.push(new URLSearchParams(init.body).get("refresh_token") ?? "");
      return { status: 200, json: async () => responses.shift() };
    };
    let clock = 0;
    const provider = new OAuthAuthProvider(account, secrets, { fetch, now: () => clock });
    expect(await provider.accessToken()).toBe("at-1");
    clock = 3600_000;
    expect(await provider.accessToken()).toBe("at-2");
    expect(used).toEqual(["rt-1", "rt-2"]);
  });

  it("refreshes before expiry and shares one refresh between concurrent callers", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt");
    const ep = tokenEndpoint([
      [200, { access_token: "a", expires_in: 3600 }],
      [200, { access_token: "b", expires_in: 3600 }],
    ]);
    let clock = 0;
    const provider = new OAuthAuthProvider(account, secrets, { fetch: ep.fetch, now: () => clock });
    const [x, y] = await Promise.all([provider.accessToken(), provider.accessToken()]);
    expect([x, y]).toEqual(["a", "a"]);
    clock = 3600_000 - 60_000; // inside the 2-minute skew
    expect(await provider.accessToken()).toBe("b");
    expect(ep.calls()).toBe(2);
  });

  it("asks the user to sign in again when the refresh token was revoked", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt");
    const ep = tokenEndpoint([[400, { error: "invalid_grant", error_description: "AADSTS50173: password changed" }]]);
    const provider = new OAuthAuthProvider(account, secrets, { fetch: ep.fetch });
    const err = await provider.imapAuth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthReauthRequiredError);
    expect((err as Error).message).toMatch(/Sign in again/);
  });

  it("tells Claude to run sign_in when no refresh token is stored", async () => {
    const provider = new OAuthAuthProvider(account, new MemorySecretStore(), { fetch: tokenEndpoint([]).fetch });
    await expect(provider.imapAuth()).rejects.toBeInstanceOf(OAuthSignInRequiredError);
    await expect(provider.imapAuth()).rejects.toThrow(/Not signed in yet .* ask me to run sign_in/);
  });

  it("reports a missing Microsoft client id at use time, not at construction", async () => {
    const noClient = AccountSchema.parse({ ...account, auth: { type: "oauth2", provider: "microsoft" } });
    const provider = new OAuthAuthProvider(noClient, new MemorySecretStore());
    await expect(provider.imapAuth()).rejects.toBeInstanceOf(OAuthConfigurationError);
  });

  it("fetches a fresh token after invalidate() (the connection manager does this after a rejected login)", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt");
    const ep = tokenEndpoint([
      [200, { access_token: "first", expires_in: 3600 }],
      [200, { access_token: "second", expires_in: 3600 }],
    ]);
    const provider = new OAuthAuthProvider(account, secrets, { fetch: ep.fetch, now: () => 0 });
    expect(await provider.accessToken()).toBe("first");
    await provider.invalidate();
    expect(await provider.accessToken()).toBe("second");
  });
});
