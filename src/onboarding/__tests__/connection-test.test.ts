import { describe, it, expect } from "vitest";
import { AccountSchema } from "../../config/schema.js";
import { CertificatePinMismatchError } from "../../connection-security.js";
import { OAuthReauthRequiredError } from "../../auth/oauth/errors.js";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { diagnose, isAuthenticationFailure } from "../diagnose.js";
import { testAccountConnection } from "../connection-test.js";

const ctx = { protocol: "imap" as const, host: "mail.example.com", port: 993 };
const passwordProvider = {
  imapAuth: async () => ({ user: "max@example.com", pass: "pw" }),
  smtpAuth: async () => ({ user: "max@example.com", pass: "pw" }),
  invalidate: async () => {},
};

describe("diagnose", () => {
  it("explains imapflow login failures with the provider's app-password hint", () => {
    const err = Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "Invalid credentials" });
    const d = diagnose(err, { ...ctx, presetId: "gmail" });
    expect(d.code).toBe("auth_failed");
    expect(d.message.de).toMatch(/App-Passwort/);
    expect(d.message.en).toContain("https://support.google.com/accounts/answer/185833");
  });

  it("recognises Microsoft 365 with SMTP AUTH disabled", () => {
    const err = Object.assign(new Error("Invalid login"), {
      code: "EAUTH",
      response: "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.",
    });
    expect(diagnose(err, { ...ctx, protocol: "smtp", port: 587 }).code).toBe("smtp_auth_disabled");
  });

  it("recognises Microsoft basic-auth retirement", () => {
    const err = Object.assign(new Error("Invalid login"), { code: "EAUTH", response: "535 5.7.139 Authentication unsuccessful, basic authentication is disabled." });
    expect(diagnose(err, ctx).code).toBe("basic_auth_disabled");
  });

  it("offers certificate pinning for self-signed certificates", () => {
    const err = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(diagnose(err, ctx)).toMatchObject({ code: "certificate_untrusted", offerCertificatePinning: true });
  });

  it("warns loudly about a changed pinned certificate", () => {
    expect(diagnose(new CertificatePinMismatchError("AA", "BB"), ctx).code).toBe("certificate_pin_mismatch");
  });

  it("refuses to suggest plaintext when STARTTLS is missing", () => {
    const err = Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true });
    const d = diagnose(err, { ...ctx, port: 143 });
    expect(d.code).toBe("starttls_missing");
    expect(d.message.en).toMatch(/port 993/);
  });

  it.each([
    ["ECONNREFUSED", "connection_refused"],
    ["ENOTFOUND", "host_not_found"],
    ["CONNECT_TIMEOUT", "timeout"],
    ["ETIMEDOUT", "timeout"],
  ])("maps %s to %s", (code, expected) => {
    expect(diagnose(Object.assign(new Error(code), { code }), ctx).code).toBe(expected);
  });

  it("recognises imapflow and nodemailer authentication errors", () => {
    expect(isAuthenticationFailure({ authenticationFailed: true })).toBe(true);
    expect(isAuthenticationFailure({ code: "EAUTH" })).toBe(true);
    expect(isAuthenticationFailure(new Error("timeout"))).toBe(false);
  });

  it("passes OAuth re-authentication errors through", () => {
    expect(diagnose(new OAuthReauthRequiredError("work", "revoked"), ctx).code).toBe("oauth_reauth");
  });
});

describe("testAccountConnection", () => {
  const account = AccountSchema.parse({
    id: "main",
    email: "max@example.com",
    imap: { host: "mail.example.com", port: 993 },
    smtp: { host: "mail.example.com", port: 465 },
  });

  it("reports capabilities including custom keyword support", async () => {
    const imap = new FakeImap();
    imap.addFolder("Sent", { specialUse: "\\Sent" });
    const report = await testAccountConnection(account, passwordProvider, {
      connectImap: async () => imap as never,
      verifySmtp: async () => {},
    });
    expect(report.imap).toMatchObject({ ok: true, folderCount: 2, capabilities: { uidplus: true, move: true, specialUse: true, customKeywords: true } });
    expect(report.smtp).toEqual({ ok: true });
  });

  it("detects servers without custom keywords (Exchange)", async () => {
    const imap = new FakeImap();
    imap.folders.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged"]);
    const report = await testAccountConnection(account, passwordProvider, { connectImap: async () => imap as never, verifySmtp: async () => {} });
    expect(report.imap.ok && report.imap.capabilities.customKeywords).toBe(false);
  });

  it("logs in only once when the password is wrong", async () => {
    let attempts = 0;
    const report = await testAccountConnection(account, passwordProvider, {
      presetId: "gmx",
      connectImap: async () => {
        attempts++;
        throw Object.assign(new Error("Command failed"), { authenticationFailed: true });
      },
      verifySmtp: async () => {},
    });
    expect(attempts).toBe(1);
    expect(report.imap.ok).toBe(false);
    if (!report.imap.ok) expect(report.imap.diagnosis.message.de).toMatch(/POP3\/IMAP Abruf/);
  });

  it("diagnoses SMTP failures separately", async () => {
    const report = await testAccountConnection(account, passwordProvider, {
      connectImap: async () => new FakeImap() as never,
      verifySmtp: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    });
    expect(report.imap.ok).toBe(true);
    expect(report.smtp).toMatchObject({ ok: false, diagnosis: { code: "connection_refused" } });
  });
});
