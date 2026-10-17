import { describe, it, expect } from "vitest";
import { AccountSchema, ConfigSchema } from "../schema.js";

const account = { id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } };

describe("policy and audit in the config schema", () => {
  it("gives every account the default policy", () => {
    const parsed = AccountSchema.parse(account);
    expect(parsed.policy.send.mode).toBe("confirm");
    expect(parsed.policy.bulk).toEqual({ maxMessages: 500, maxDelete: 100 });
  });

  it("accepts a partial policy and fills the rest", () => {
    const parsed = AccountSchema.parse({ ...account, policy: { send: { mode: "drafts-only" }, folders: { deny: ["**/HR/**"] } } });
    expect(parsed.policy.send).toMatchObject({ mode: "drafts-only", maxPerHour: 20 });
    expect(parsed.policy.folders).toEqual({ deny: ["**/HR/**"] });
  });

  it("rejects a misspelt policy setting instead of ignoring it", () => {
    expect(AccountSchema.safeParse({ ...account, policy: { send: { maxPerHours: 5 } } }).success).toBe(false);
  });

  it("enables auditing by default", () => {
    expect(ConfigSchema.parse({ version: 2, accounts: [account] }).audit).toEqual({
      enabled: true,
      level: "standard",
      retentionDays: 365,
      includeReads: false,
    });
  });
});
