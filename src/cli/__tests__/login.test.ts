import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../config/schema.js";
import { MemorySecretStore } from "../../secrets/memory-store.js";
import type { InteractiveAuthOptions } from "../../auth/oauth/flow.js";
import type { OAuthProfile } from "../../auth/oauth/profiles.js";
import { runAccountsLogin, type LoginDeps } from "../login.js";

const config = ConfigSchema.parse({
  version: 2,
  accounts: [
    { id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } },
    { id: "work", email: "max@firma.at", imap: { host: "outlook.office365.com", port: 993 }, auth: { type: "oauth2", provider: "microsoft", clientId: "cid", tenant: "firma.at" } },
    {
      id: "gws",
      email: "max@firma-gws.at",
      imap: { host: "imap.gmail.com", port: 993 },
      auth: { type: "oauth2", provider: "google", clientId: "x.apps.googleusercontent.com", clientSecret: "s" },
    },
  ],
});

function deps(overrides: Partial<LoginDeps> = {}) {
  const lines: string[] = [];
  const secrets = new MemorySecretStore();
  const calls: Array<{ kind: "loopback" | "device"; profile: OAuthProfile; opts: InteractiveAuthOptions }> = [];
  const d: LoginDeps = {
    locale: "en",
    print: (l) => lines.push(l),
    loadConfig: async () => config,
    secrets,
    loopback: async (profile, opts) => {
      calls.push({ kind: "loopback", profile, opts });
      return { accessToken: "at", refreshToken: "rt-loopback", expiresAt: 0 };
    },
    deviceCode: async (profile, opts) => {
      calls.push({ kind: "device", profile, opts });
      return { accessToken: "at", refreshToken: "rt-device", expiresAt: 0 };
    },
    ...overrides,
  };
  return { d, lines, secrets, calls };
}

describe("accounts login", () => {
  it("signs in with the browser and stores the refresh token", async () => {
    const { d, lines, secrets, calls } = deps();
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "work", mode: "browser" }, d)).toBe(0);
    expect(await secrets.get("work", "oauthRefreshToken")).toBe("rt-loopback");
    expect(calls[0].profile.tokenUrl).toContain("/firma.at/");
    expect(calls[0].opts).toMatchObject({ loginHint: "max@firma.at", language: "en" });
    expect(calls[0].opts.openBrowser).toBeUndefined();
    expect(lines.at(-1)).toBe("✓ Signed in: max@firma.at. The sign-in has been saved.");
  });

  it("--no-browser disables the browser and passes listen host and port (container)", async () => {
    const { d, calls } = deps();
    await runAccountsLogin({ command: "accounts-login", accountId: "work", mode: "no-browser", listenHost: "0.0.0.0", port: 53682 }, d);
    expect(calls[0].opts).toMatchObject({ openBrowser: false, listenHost: "0.0.0.0", port: 53682 });
  });

  it("--device-code uses the Microsoft device code flow", async () => {
    const { d, secrets, calls } = deps();
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "work", mode: "device-code" }, d)).toBe(0);
    expect(calls[0].kind).toBe("device");
    expect(await secrets.get("work", "oauthRefreshToken")).toBe("rt-device");
  });

  it("refuses the device code flow for Google with a clear message", async () => {
    const { d, lines, calls } = deps();
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "gws", mode: "device-code" }, d)).toBe(1);
    expect(lines.join("\n")).toContain("Google offers no sign-in with a code");
    expect(calls).toHaveLength(0);
  });

  it("refuses password accounts and unknown ids", async () => {
    const { d, lines, calls } = deps();
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "main", mode: "browser" }, d)).toBe(1);
    expect(lines.at(-1)).toMatch(/signs in with a password/);
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "nope", mode: "browser" }, d)).toBe(1);
    expect(lines.at(-1)).toBe('There is no mailbox "nope". Configured: main, work, gws.');
    expect(calls).toHaveLength(0);
  });

  it("reports a failed sign-in and stores nothing", async () => {
    const { d, lines, secrets } = deps({
      loopback: async () => {
        throw new Error("Sign-in was cancelled or access was not granted.");
      },
    });
    expect(await runAccountsLogin({ command: "accounts-login", accountId: "work", mode: "browser" }, d)).toBe(1);
    expect(lines.at(-1)).toBe("✗ Sign-in failed: Sign-in was cancelled or access was not granted.");
    expect(await secrets.get("work", "oauthRefreshToken")).toBeNull();
  });
});
