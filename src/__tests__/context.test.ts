import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../config/schema.js";
import { AccountNotFoundError, createAppContext } from "../context.js";
import type { SecretStore } from "../secrets/store.js";
import { FakeImap } from "./helpers/fake-imap.js";

const secrets: SecretStore = { get: async () => "pw", set: async () => {}, delete: async () => {} };

function app(accounts: Array<Record<string, unknown>>, defaultAccount?: string) {
  const config = ConfigSchema.parse({
    version: 2,
    ...(defaultAccount ? { defaultAccount } : {}),
    accounts: accounts.map((a) => ({ imap: { host: "imap.example.com", port: 993 }, ...a })),
  });
  return createAppContext(config, secrets, { connectImap: () => async () => new FakeImap().asClient() });
}

describe("AppContext", () => {
  it("defaults to the first account, or to defaultAccount when set", () => {
    const accounts = [
      { id: "office", email: "office@firma.at" },
      { id: "private", email: "max@gmx.at" },
    ];
    expect(app(accounts).resolveAccount(undefined).id).toBe("office");
    expect(app(accounts, "private").resolveAccount(undefined).id).toBe("private");
    expect(app(accounts).resolveAccount("  ").id).toBe("office");
  });

  it("names the available accounts for an unknown id", () => {
    expect(() => app([{ id: "office", email: "o@firma.at" }]).resolveAccount("shop")).toThrow(AccountNotFoundError);
  });

  it("knows whether any account grants a tier", () => {
    const ctx = app([
      { id: "office", email: "o@firma.at", permissions: { send: true } },
      { id: "private", email: "p@gmx.at" },
    ]);
    expect(ctx.anyAccountAllows("send")).toBe(true);
    expect(ctx.anyAccountAllows("delete")).toBe(false);
  });

  it("collects own addresses from the account email and all identities (lower-cased)", () => {
    const account = app([{ id: "office", email: "Office@Firma.at", identities: [{ email: "Info@Firma.at", name: "Firma" }] }]).resolveAccount("office");
    expect(account.ownAddresses).toEqual(["info@firma.at", "office@firma.at"]);
  });

  it("uses the first identity as default sender and always allows the account email", () => {
    const account = app([
      { id: "office", email: "office@firma.at", identities: [{ email: "info@firma.at", name: "Firma" }] },
    ]).resolveAccount("office");
    expect(account.identityFor()).toEqual({ email: "info@firma.at", name: "Firma" });
    expect(account.identityFor("OFFICE@firma.at")).toEqual({ email: "office@firma.at" });
    expect(() => account.identityFor("boss@firma.at")).toThrow(/not a sender address/);
  });

  it("explains that an account without SMTP cannot send", () => {
    const account = app([{ id: "office", email: "office@firma.at" }]).resolveAccount("office");
    expect(() => account.getSendDeps()).toThrow(/no outgoing \(SMTP\) server/);
  });

  it("builds send dependencies once per account with the configured Sent-copy mode", () => {
    const account = app([
      { id: "office", email: "office@firma.at", smtp: { host: "smtp.firma.at", port: 587 }, sentCopy: "never" },
    ]).resolveAccount("office");
    const deps = account.getSendDeps();
    expect(deps).toBe(account.getSendDeps());
    expect(deps).toMatchObject({ imapHost: "imap.example.com", sentCopy: "never" });
  });
});
