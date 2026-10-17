import { describe, it, expect, beforeAll } from "vitest";
import { ConfigSchema, type AccountConfig, type AppConfig } from "../../config/schema.js";
import type { AuthProvider } from "../../auth/provider.js";
import { OAuthAuthProvider } from "../../auth/oauth/provider.js";
import { detectProvider, type DetectedProvider } from "../../onboarding/autoconfig.js";
import type { AccountTestReport } from "../../onboarding/connection-test.js";
import type { Diagnosis } from "../../onboarding/diagnose.js";
import type { StoredSecret } from "../../secrets/memory-store.js";
import { scriptedPrompter } from "../../__tests__/helpers/scripted-prompter.js";
import { selfSignedCert, type SelfSignedCert } from "../../__tests__/helpers/tls-fixtures.js";

let cert: SelfSignedCert;
beforeAll(async () => {
  cert = await selfSignedCert("mail.firma.example");
});
import { runSetup, suggestAccountId, type SetupDeps } from "../setup.js";

const OK: AccountTestReport = {
  imap: { ok: true, folderCount: 7, capabilities: { specialUse: true, uidplus: true, move: true, idle: true, customKeywords: true } },
  smtp: { ok: true },
};

function failing(step: "imap" | "smtp", diagnosis: Diagnosis): AccountTestReport {
  return step === "imap" ? { ...OK, imap: { ok: false, diagnosis, error: new Error(diagnosis.code) } } : { ...OK, smtp: { ok: false, diagnosis, error: new Error(diagnosis.code) } };
}

function harness(opts: {
  answers: Array<string | boolean>;
  existing?: AppConfig;
  detected?: DetectedProvider;
  reports?: AccountTestReport[];
}) {
  const saved: Array<{ config: AppConfig; secrets: StoredSecret[]; removed: string[] }> = [];
  const tested: Array<{ account: AccountConfig; auth: unknown }> = [];
  const reports = [...(opts.reports ?? [OK])];
  const prompter = scriptedPrompter(opts.answers);
  const deps: SetupDeps = {
    prompter,
    locale: "de",
    loadExisting: async () => opts.existing,
    save: async (config, secrets, removed) => {
      saved.push({ config, secrets, removed });
    },
    detect: async (email) => opts.detected ?? detectProvider(email, { network: false }),
    test: async (account: AccountConfig, provider: AuthProvider) => {
      // never let an OAuth provider talk to the real token endpoint from a unit test
      tested.push({ account, auth: provider instanceof OAuthAuthProvider ? "oauth" : await provider.imapAuth() });
      return reports.shift() ?? OK;
    },
    probe: async () => ({
      pem: cert.cert,
      fingerprint256: cert.fingerprint256,
      subject: "CN=mail.firma.example",
      issuer: "CN=mail.firma.example",
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2036-01-01T00:00:00.000Z",
      selfSigned: true,
      trusted: false,
      hostnameMatches: true,
    }),
    authorize: async () => ({ refreshToken: "refresh-123" }),
  };
  return { deps, saved, tested, prompter };
}

const selfHosted: DetectedProvider = {
  name: "firma.example",
  imap: { host: "mail.firma.example", port: 143, security: "starttls" },
  smtp: { host: "mail.firma.example", port: 587, security: "starttls" },
  auth: "password",
  usernameStyle: "address",
  notes: [],
  source: "autoconfig",
};

describe("runSetup — first account", () => {
  it("sets up a WEB.DE mailbox with hidden password, local-part login and safe default permissions", async () => {
    const { deps, saved, tested, prompter } = harness({
      // email, use detected, id, display name, password, read, write, send, delete
      answers: ["max@web.de", "", "", "Max Achleitner", "geheim", "", "", "", ""],
    });
    expect(await runSetup(deps)).toBe(0);
    expect(tested[0].auth).toEqual({ user: "max", pass: "geheim" });
    const account = saved[0].config.accounts[0];
    expect(account).toMatchObject({
      id: "main",
      email: "max@web.de",
      imap: { host: "imap.web.de", port: 993 },
      smtp: { host: "smtp.web.de", port: 587 },
      auth: { type: "password", username: "max" },
      identities: [{ email: "max@web.de", name: "Max Achleitner" }],
      permissions: { read: true, write: true, send: false, delete: false },
    });
    expect(saved[0].secrets).toEqual([{ accountId: "main", key: "password", value: "geheim" }]);
    expect(prompter.output.join("\n")).toContain("POP3/IMAP Abruf");
    expect(JSON.stringify(saved[0].config)).not.toContain("geheim");
  });

  it("pins a self-signed certificate only after the user confirms it", async () => {
    const untrusted: Diagnosis = { code: "certificate_untrusted", offerCertificatePinning: true, message: { de: "selbst signiert", en: "self-signed" } };
    const { deps, saved, tested, prompter } = harness({
      detected: selfHosted,
      reports: [failing("imap", untrusted), OK],
      answers: ["max@firma.example", "", "", "", "pw", true, "", "", "", ""],
    });
    expect(await runSetup(deps)).toBe(0);
    expect(tested).toHaveLength(2);
    expect(saved[0].config.accounts[0].imap).toMatchObject({
      host: "mail.firma.example",
      tlsFingerprint256: cert.fingerprint256,
      tlsCertificatePem: cert.cert,
    });
    expect(prompter.output.join("\n")).toContain(`SHA-256: ${cert.fingerprint256}`);
  });

  it("does not save when the user refuses to trust the certificate", async () => {
    const untrusted: Diagnosis = { code: "certificate_untrusted", offerCertificatePinning: true, message: { de: "x", en: "x" } };
    const { deps, saved } = harness({
      detected: selfHosted,
      reports: [failing("imap", untrusted)],
      // … trust? no, save anyway? no
      answers: ["max@firma.example", "", "", "", "pw", false, false],
    });
    expect(await runSetup(deps)).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it("asks for the password again after a rejected login", async () => {
    const rejected: Diagnosis = { code: "auth_failed", message: { de: "abgelehnt", en: "rejected" } };
    const { deps, saved, tested } = harness({
      reports: [failing("imap", rejected), OK],
      answers: ["max@gmx.at", "", "", "", "falsch", true, "richtig", "", "", "", ""],
    });
    expect(await runSetup(deps)).toBe(0);
    expect(tested.map((x) => x.auth)).toEqual([{ user: "max@gmx.at", pass: "falsch" }, { user: "max@gmx.at", pass: "richtig" }]);
    expect(saved[0].secrets).toEqual([{ accountId: "main", key: "password", value: "richtig" }]);
  });

  it("signs in to Microsoft 365 with OAuth and stores only the refresh token", async () => {
    const m365 = await detectProvider("office@firma.at", {
      resolveMx: async () => [{ exchange: "firma-at.mail.protection.outlook.com", priority: 0 }],
      fetch: async () => ({ status: 404, text: async () => "" }),
    });
    const { deps, saved, prompter } = harness({
      detected: m365,
      // email, use detected, auth method, id, name, client id, tenant, sign-in mode, perms ×4
      answers: ["office@firma.at", "", "oauth", "", "", "11111111-2222-3333-4444-555555555555", "firma.at", "browser", "", "", "", ""],
    });
    expect(await runSetup(deps)).toBe(0);
    expect(saved[0].config.accounts[0].auth).toEqual({
      type: "oauth2",
      provider: "microsoft",
      clientId: "11111111-2222-3333-4444-555555555555",
      tenant: "firma.at",
    });
    expect(saved[0].secrets).toEqual([{ accountId: "main", key: "oauthRefreshToken", value: "refresh-123" }]);
    expect(prompter.asked.some((q) => q.includes("Client-ID"))).toBe(true);
  });
});

describe("runSetup — existing configuration", () => {
  const existing = ConfigSchema.parse({
    version: 2,
    accounts: [
      { id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } },
      { id: "work", email: "max@firma.at", imap: { host: "outlook.office365.com", port: 993 }, auth: { type: "oauth2", provider: "microsoft", clientId: "c" } },
    ],
  });

  it("removes an account and its secrets", async () => {
    const { deps, saved } = harness({ existing, answers: ["remove", "work", true, "done"] });
    expect(await runSetup(deps)).toBe(0);
    expect(saved[0].config.accounts.map((a) => a.id)).toEqual(["main"]);
    expect(saved[0].removed).toEqual(["work"]);
  });

  it("re-runs the Microsoft sign-in for an OAuth account", async () => {
    const { deps, saved } = harness({ existing, answers: ["reauth", "work", "browser", "done"] });
    expect(await runSetup(deps)).toBe(0);
    expect(saved[0].secrets).toEqual([{ accountId: "work", key: "oauthRefreshToken", value: "refresh-123" }]);
  });

  it("suggests unique account ids", () => {
    expect(suggestAccountId("a@web.de", new Set())).toBe("main");
    expect(suggestAccountId("a@firma.at", new Set(["main", "firma-at"]))).toBe("firma-at-2");
  });
});
