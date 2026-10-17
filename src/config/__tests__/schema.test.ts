import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../schema.js";

const account = (over: Record<string, unknown> = {}) => ({
  id: "main",
  email: "max@firma.example",
  imap: { host: "mail.firma.example", port: 993 },
  ...over,
});

describe("ConfigSchema", () => {
  it("fills safe defaults: read+write on, send+delete off, password auth, auto Sent copy", () => {
    const config = ConfigSchema.parse({ version: 2, accounts: [account()] });
    expect(config.accounts[0]).toMatchObject({
      permissions: { read: true, write: true, send: false, delete: false },
      auth: { type: "password" },
      sentCopy: "auto",
      locale: "en",
      identities: [],
    });
  });

  it("rejects duplicate account ids", () => {
    const result = ConfigSchema.safeParse({ version: 2, accounts: [account(), account()] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/Duplicate account id/);
  });

  it("rejects a defaultAccount that does not exist", () => {
    const result = ConfigSchema.safeParse({ version: 2, defaultAccount: "office", accounts: [account()] });
    expect(result.success).toBe(false);
  });

  it.each(["Main", "my account", "", "a".repeat(33)])("rejects account id %j", (id) => {
    expect(ConfigSchema.safeParse({ version: 2, accounts: [account({ id })] }).success).toBe(false);
  });

  it("rejects an invalid identity email", () => {
    const result = ConfigSchema.safeParse({ version: 2, accounts: [account({ identities: [{ email: "not-an-email" }] })] });
    expect(result.success).toBe(false);
  });

  it("fills the full policy from a partial one (the strict Plan 5 schema replaced the loose placeholder)", () => {
    const config = ConfigSchema.parse({ version: 2, accounts: [account({ policy: { send: { mode: "confirm" } } })] });
    expect(config.accounts[0].policy.send).toMatchObject({ mode: "confirm", maxPerHour: 20 });
  });
});
