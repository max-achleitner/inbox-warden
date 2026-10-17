import { describe, it, expect } from "vitest";
import { AccountSchema } from "../../../config/schema.js";
import { MemorySecretStore } from "../../../secrets/memory-store.js";
import { OAuthAuthorizationError, OAuthConfigurationError } from "../errors.js";
import type { AuthorizedTokens, InteractiveAuthOptions } from "../flow.js";
import type { OAuthProfile } from "../profiles.js";
import { SignInManager } from "../sign-in-manager.js";
import type { FetchLike } from "../tokens.js";

const oauthAccount = AccountSchema.parse({
  id: "work",
  email: "max@firma.at",
  imap: { host: "outlook.office365.com", port: 993 },
  auth: { type: "oauth2", provider: "microsoft", clientId: "cid" },
  locale: "de",
});

/** Fake browser flow: announces the URL, then waits until the test settles it. */
function controllableAuthorize() {
  let settle!: { resolve: (t: AuthorizedTokens) => void; reject: (e: Error) => void };
  const calls: InteractiveAuthOptions[] = [];
  const authorize = (_profile: OAuthProfile, opts: InteractiveAuthOptions) => {
    calls.push(opts);
    return new Promise<AuthorizedTokens>((resolve, reject) => {
      settle = { resolve, reject };
      opts.onAuthorizeUrl?.("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1");
    });
  };
  return { authorize, calls, complete: (rt: string) => settle.resolve({ accessToken: "at", refreshToken: rt, expiresAt: 0 }), fail: (e: Error) => settle.reject(e) };
}

const answering = (status: number, body: unknown): FetchLike => async () => ({ status, json: async () => body });

describe("SignInManager", () => {
  it("is not needed for password accounts", async () => {
    const manager = new SignInManager({ secrets: new MemorySecretStore() });
    const password = AccountSchema.parse({ id: "main", email: "a@b.at", imap: { host: "h", port: 993 } });
    expect(await manager.signIn(password, 10)).toEqual({ state: "not_needed" });
  });

  it("reports signed_in when the stored refresh token still works", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "rt");
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets, authorize: fake.authorize, tokenDeps: { fetch: answering(200, { access_token: "a", expires_in: 3600 }) } });
    expect(await manager.signIn(oauthAccount, 10)).toEqual({ state: "signed_in" });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns the sign-in link while waiting and stores the token when the user finishes", async () => {
    const secrets = new MemorySecretStore();
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets, authorize: fake.authorize, now: () => 1000 });

    const first = await manager.signIn(oauthAccount, 10);
    expect(first).toEqual({ state: "waiting", url: expect.stringContaining("login.microsoftonline.com"), expiresAt: 1000 + 5 * 60_000 });
    expect(fake.calls[0]).toMatchObject({ loginHint: "max@firma.at", language: "de", timeoutMs: 300_000 });

    fake.complete("rt-new");
    expect(await manager.signIn(oauthAccount, 1000)).toEqual({ state: "signed_in" });
    expect(await secrets.get("work", "oauthRefreshToken")).toBe("rt-new");
    expect(fake.calls).toHaveLength(1);
  });

  it("starts a new sign-in when the stored token was revoked", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("work", "oauthRefreshToken", "revoked");
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets, authorize: fake.authorize, tokenDeps: { fetch: answering(400, { error: "invalid_grant" }) } });
    expect((await manager.signIn(oauthAccount, 10)).state).toBe("waiting");
  });

  it("reports a token that cannot be stored as failed and allows a fresh sign-in afterwards", async () => {
    const secrets = new MemorySecretStore();
    const realSet = secrets.set.bind(secrets);
    let keychainLocked = true;
    secrets.set = async (...args: Parameters<typeof realSet>) => {
      if (keychainLocked) throw new Error("The keychain is locked");
      return realSet(...args);
    };
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets, authorize: fake.authorize });

    await manager.signIn(oauthAccount, 10);
    fake.complete("rt-1");
    const failed = await manager.signIn(oauthAccount, 1000);
    expect(failed).toEqual({ state: "failed", error: expect.stringMatching(/could not be saved.*keychain is locked/) });

    keychainLocked = false;
    expect((await manager.signIn(oauthAccount, 10)).state).toBe("waiting");
    expect(fake.calls).toHaveLength(2);
    fake.complete("rt-2");
    expect(await manager.signIn(oauthAccount, 1000)).toEqual({ state: "signed_in" });
  });

  it("shares one browser flow between repeated calls", async () => {
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets: new MemorySecretStore(), authorize: fake.authorize });
    await manager.signIn(oauthAccount, 10);
    await manager.signIn(oauthAccount, 10);
    expect(fake.calls).toHaveLength(1);
  });

  it("reports a cancelled sign-in once and then allows a new attempt", async () => {
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets: new MemorySecretStore(), authorize: fake.authorize });
    await manager.signIn(oauthAccount, 10);
    fake.fail(new OAuthAuthorizationError("access_denied"));
    expect(await manager.signIn(oauthAccount, 1000)).toEqual({ state: "failed", error: "Sign-in was cancelled or access was not granted." });
    expect((await manager.signIn(oauthAccount, 10)).state).toBe("waiting");
    expect(fake.calls).toHaveLength(2);
  });

  it("explains a missing Microsoft client id instead of opening a browser", async () => {
    const noClient = AccountSchema.parse({ ...oauthAccount, auth: { type: "oauth2", provider: "microsoft" } });
    const fake = controllableAuthorize();
    const manager = new SignInManager({ secrets: new MemorySecretStore(), authorize: fake.authorize });
    await expect(manager.signIn(noClient, 10)).rejects.toBeInstanceOf(OAuthConfigurationError);
    expect(fake.calls).toHaveLength(0);
  });
});
