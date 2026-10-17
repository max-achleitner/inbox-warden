import { describe, it, expect } from "vitest";
import { AccountSchema } from "../../config/schema.js";
import { createAuthProvider } from "../provider.js";
import { OAuthAuthProvider } from "../oauth/provider.js";
import type { SecretStore } from "../../secrets/store.js";

const account = (over: Record<string, unknown> = {}) =>
  AccountSchema.parse({ id: "office", email: "office@firma.at", imap: { host: "imap.firma.at", port: 993 }, ...over });

function store(values: Record<string, string>): SecretStore & { reads: number } {
  const s = {
    reads: 0,
    async get(id: string, key: string) {
      s.reads++;
      return values[`${id}:${key}`] ?? null;
    },
    async set() {},
    async delete() {},
  };
  return s;
}

describe("password auth provider", () => {
  it("logs in with the email unless a separate username is configured", async () => {
    const secrets = store({ "office:password": "pw" });
    expect(await createAuthProvider(account(), secrets).imapAuth()).toEqual({ user: "office@firma.at", pass: "pw" });
    const withUsername = createAuthProvider(account({ auth: { type: "password", username: "u1234" } }), secrets);
    expect(await withUsername.smtpAuth()).toEqual({ user: "u1234", pass: "pw" });
  });

  it("caches the password and re-reads it after invalidate()", async () => {
    const secrets = store({ "office:password": "pw" });
    const provider = createAuthProvider(account(), secrets);
    await provider.imapAuth();
    await provider.smtpAuth();
    expect(secrets.reads).toBe(1);
    await provider.invalidate();
    await provider.imapAuth();
    expect(secrets.reads).toBe(2);
  });

  it("names the environment variable when no password is stored", async () => {
    await expect(createAuthProvider(account(), store({})).imapAuth()).rejects.toThrow(/IMAP_MCP_PASSWORD_OFFICE/);
  });

  it("returns the OAuth provider for oauth2 accounts, which asks for sign_in until a sign-in is stored", async () => {
    const provider = createAuthProvider(account({ auth: { type: "oauth2", provider: "microsoft", clientId: "cid" } }), store({}));
    expect(provider).toBeInstanceOf(OAuthAuthProvider);
    await expect(provider.imapAuth()).rejects.toThrow(/ask me to run sign_in/);
  });
});
