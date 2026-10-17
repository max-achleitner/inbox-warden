import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../../config/schema.js";
import { MemorySecretStore } from "../../secrets/memory-store.js";
import type { AccountTestReport } from "../../onboarding/connection-test.js";
import { describeTls, formatAccountList, runDoctor, type DoctorDeps } from "../doctor.js";

const config = ConfigSchema.parse({
  version: 2,
  accounts: [
    {
      id: "main",
      email: "max@firma.example",
      imap: { host: "mail.firma.example", port: 143 },
      smtp: { host: "mail.firma.example", port: 587 },
      permissions: { send: true },
    },
  ],
});

const OK: AccountTestReport = {
  imap: { ok: true, folderCount: 5, capabilities: { specialUse: true, uidplus: true, move: true, idle: true, customKeywords: false } },
  smtp: { ok: true },
};

function deps(secrets: MemorySecretStore, report: AccountTestReport, lines: string[]): DoctorDeps {
  return {
    locale: "en",
    print: (l) => lines.push(l),
    loadConfig: async () => config,
    secrets,
    createProvider: () => ({ imapAuth: async () => ({ user: "u", pass: "p" }), smtpAuth: async () => ({ user: "u", pass: "p" }), invalidate: async () => {} }),
    test: async () => report,
  };
}

describe("runDoctor", () => {
  it("reports a healthy account with exit code 0", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("main", "password", "pw");
    const lines: string[] = [];
    expect(await runDoctor(deps(secrets, OK, lines))).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("✓ Credentials stored");
    expect(text).toContain("IMAP: encrypted (mandatory STARTTLS, port 143)");
    expect(text).toContain("Custom labels: no");
    expect(text).toContain("read ✓, write ✓, send ✓, delete ✗");
    expect(text).toContain("Everything is fine.");
  });

  it("fails with exit code 1 when the secret is missing", async () => {
    const lines: string[] = [];
    expect(await runDoctor(deps(new MemorySecretStore(), OK, lines))).toBe(1);
    expect(lines.join("\n")).toContain("No credentials stored");
  });

  it("prints the diagnosis of a failing step", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("main", "password", "pw");
    const lines: string[] = [];
    const broken: AccountTestReport = { ...OK, smtp: { ok: false, error: new Error(), diagnosis: { code: "timeout", message: { de: "x", en: "SMTP does not answer" } } } };
    expect(await runDoctor(deps(secrets, broken, lines))).toBe(1);
    expect(lines.join("\n")).toContain("✗ Sending (SMTP): SMTP does not answer");
  });

  it("reports an unreadable configuration", async () => {
    const lines: string[] = [];
    const d = { ...deps(new MemorySecretStore(), OK, lines), loadConfig: async () => { throw new Error("No configuration found"); } };
    expect(await runDoctor(d)).toBe(1);
    expect(lines.join("\n")).toContain("inbox-warden setup");
  });
});

describe("describeTls / formatAccountList", () => {
  it("describes pinned and loopback endpoints", () => {
    expect(describeTls("en", "IMAP", { host: "127.0.0.1", port: 1143 })).toContain("local connection");
    expect(describeTls("en", "IMAP", { host: "x", port: 993, tlsFingerprint256: "AB:CD", tlsCertificatePem: "P" })).toContain("pinned certificate");
  });

  it("lists accounts with auth type and tiers", () => {
    expect(formatAccountList("en", config)[0]).toMatch(/main\s+max@firma.example\s+mail\.firma.example\s+password\s+read\+write\+send/);
  });
});
