import { describe, it, expect } from "vitest";
import { ConfigSchema, type AppConfig } from "../../config/schema.js";
import { MemorySecretStore } from "../../secrets/memory-store.js";
import { parseCliArgs, type AccountsEditCommand } from "../args.js";
import { runAccountsEdit, type EditDeps } from "../edit.js";

const base = () =>
  ConfigSchema.parse({
    version: 2,
    accounts: [
      { id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 }, smtp: { host: "mail.firma.example", port: 465 } },
      { id: "work", email: "max@firma.at", imap: { host: "outlook.office365.com", port: 993 }, auth: { type: "oauth2", provider: "microsoft", clientId: "cid", tenant: "firma.at" } },
    ],
  });

function deps(config: AppConfig | null = base(), overrides: Partial<EditDeps> = {}) {
  const lines: string[] = [];
  const saved: AppConfig[] = [];
  const secrets = new MemorySecretStore();
  const d: EditDeps = {
    locale: "en",
    print: (l) => lines.push(l),
    loadConfig: async () => config ?? undefined,
    saveConfig: async (c) => {
      saved.push(c);
    },
    secrets,
    readSecret: async () => "new-app-password",
    ...overrides,
  };
  return { d, lines, saved, secrets };
}

const edit = (argv: string[]) => parseCliArgs(["accounts", "edit", ...argv]) as AccountsEditCommand;

describe("accounts edit: arguments", () => {
  it("parses permissions, default, bulk limits and password", () => {
    expect(parseCliArgs(["accounts", "edit", "main", "--allow", "send", "--deny", "delete", "--default", "--max-messages", "1000", "--max-delete", "50", "--password"])).toEqual({
      command: "accounts-edit",
      accountId: "main",
      allow: ["send"],
      deny: ["delete"],
      makeDefault: true,
      maxMessages: 1000,
      maxDelete: 50,
      password: true,
    });
  });

  it.each([
    [["main"], /at least one option/],
    [[], /needs the mailbox id/],
    [["main", "--allow", "everything"], /read, write, send or delete/],
    [["main", "--allow", "send", "--deny", "send"], /both allowed and denied/],
    [["main", "--max-messages", "0"], /positive whole number/],
    [["main", "--max-messages"], /needs a value/],
    [["main", "--colour"], /Unknown option/],
  ])("rejects %j", (argv, message) => {
    const cmd = parseCliArgs(["accounts", "edit", ...argv]);
    expect(cmd.command).toBe("invalid");
    expect(cmd.command === "invalid" && cmd.message.en).toMatch(message);
  });
});

describe("accounts edit: command", () => {
  it("changes permissions and bulk limits, saves, and says what changed", async () => {
    const { d, lines, saved } = deps();
    expect(await runAccountsEdit(edit(["main", "--allow", "send", "--max-messages", "1000"]), d)).toBe(0);
    const account = saved[0].accounts.find((a) => a.id === "main")!;
    expect(account.permissions.send).toBe(true);
    expect(account.policy.bulk.maxMessages).toBe(1000);
    expect(lines.join("\n")).toMatch(/send: off → on/);
    expect(lines.join("\n")).toMatch(/bulk\.maxMessages: 500 → 1000/);
    expect(lines.join("\n")).toMatch(/[Rr]estart/);
  });

  it("makes an account the default", async () => {
    const { d, saved } = deps();
    expect(await runAccountsEdit(edit(["work", "--default"]), d)).toBe(0);
    expect(saved[0].defaultAccount).toBe("work");
  });

  it("stores a new password in the secret store, never in the config", async () => {
    const { d, saved, secrets } = deps();
    expect(await runAccountsEdit(edit(["main", "--password"]), d)).toBe(0);
    expect(await secrets.get("main", "password")).toBe("new-app-password");
    expect(JSON.stringify(saved[0])).not.toContain("new-app-password");
  });

  it("refuses --password for an OAuth account and changes nothing", async () => {
    const { d, lines, saved } = deps();
    expect(await runAccountsEdit(edit(["work", "--password", "--allow", "send"]), d)).toBe(1);
    expect(saved).toEqual([]);
    expect(lines.join("\n")).toMatch(/accounts login work/);
  });

  it("refuses an empty password", async () => {
    const { d, saved, secrets } = deps(base(), { readSecret: async () => "" });
    expect(await runAccountsEdit(edit(["main", "--password"]), d)).toBe(1);
    expect(saved).toEqual([]);
    expect(await secrets.get("main", "password")).toBeNull();
  });

  it("names the known accounts for an unknown id", async () => {
    const { d, lines } = deps();
    expect(await runAccountsEdit(edit(["nope", "--default"]), d)).toBe(1);
    expect(lines.join("\n")).toMatch(/main, work/);
  });

  it("explains that there is no config file yet", async () => {
    const { d, lines } = deps(null);
    expect(await runAccountsEdit(edit(["main", "--default"]), d)).toBe(1);
    expect(lines.join("\n")).toMatch(/setup/);
  });
});
