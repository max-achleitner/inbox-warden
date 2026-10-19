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
      lockFolders: [],
      unlockFolders: [],
      password: true,
    });
  });

  it("parses repeated --lock-folder and --unlock-folder, trimmed and without repeats", () => {
    expect(
      edit(["main", "--lock-folder", " _NDA_Inbox ", "--lock-folder", "_NDA_*", "--lock-folder", "_NDA_Inbox", "--unlock-folder", "Alt/NDA"]),
    ).toMatchObject({ lockFolders: ["_NDA_Inbox", "_NDA_*"], unlockFolders: ["Alt/NDA"], allow: [], makeDefault: false });
  });

  it.each([
    [["main"], /at least one option/],
    [[], /needs the mailbox id/],
    [["main", "--allow", "everything"], /read, write, send or delete/],
    [["main", "--allow", "send", "--deny", "send"], /both allowed and denied/],
    [["main", "--max-messages", "0"], /positive whole number/],
    [["main", "--max-messages"], /needs a value/],
    [["main", "--colour"], /Unknown option/],
    [["main", "--lock-folder"], /--lock-folder needs a folder name/],
    [["main", "--lock-folder", "  "], /--lock-folder needs a folder name/],
    [["main", "--unlock-folder", "--default"], /--unlock-folder needs a folder name/],
    [["main", "--lock-folder", "_NDA_Inbox", "--unlock-folder", "_NDA_Inbox"], /both locked and unlocked/],
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

  describe("locked folders", () => {
    const withLock = (deny: string[]) => {
      const config = base();
      config.accounts[0].policy.folders.deny = deny;
      return config;
    };

    it("locks folders, keeps existing locks and other settings, and shows the list before and after", async () => {
      const { d, lines, saved } = deps(withLock(["Alt/NDA"]));
      expect(await runAccountsEdit(edit(["main", "--lock-folder", "_NDA_Inbox", "--lock-folder", "_NDA_*", "--allow", "send"]), d)).toBe(0);
      const account = saved[0].accounts.find((a) => a.id === "main")!;
      expect(account.policy.folders.deny).toEqual(["Alt/NDA", "_NDA_Inbox", "_NDA_*"]);
      expect(account.permissions.send).toBe(true);
      expect(saved[0].accounts.find((a) => a.id === "work")!.policy.folders.deny).toEqual([]);
      expect(lines.join("\n")).toContain("locked folders: Alt/NDA → Alt/NDA, _NDA_Inbox, _NDA_*");
      expect(lines.join("\n")).toMatch(/[Rr]estart/);
    });

    it("does not lock a folder twice", async () => {
      const { d, lines, saved } = deps(withLock(["_NDA_Inbox"]));
      expect(await runAccountsEdit(edit(["main", "--lock-folder", "_NDA_Inbox"]), d)).toBe(0);
      expect(saved).toEqual([]);
      expect(lines.join("\n")).toMatch(/Nothing was changed/);
    });

    it("unlocks an exact entry", async () => {
      const { d, lines, saved } = deps(withLock(["_NDA_Inbox", "_NDA_*"]));
      expect(await runAccountsEdit(edit(["main", "--unlock-folder", "_NDA_Inbox", "--lock-folder", "Vertrag"]), d)).toBe(0);
      expect(saved[0].accounts[0].policy.folders.deny).toEqual(["_NDA_*", "Vertrag"]);
      expect(lines.join("\n")).toContain("locked folders: _NDA_Inbox, _NDA_* → _NDA_*, Vertrag");
    });

    it("refuses to unlock a folder that is not locked, names the locked ones and saves nothing", async () => {
      const { d, lines, saved } = deps(withLock(["_NDA_Inbox"]));
      expect(await runAccountsEdit(edit(["main", "--unlock-folder", "_nda_inbox", "--lock-folder", "Vertrag", "--allow", "send"]), d)).toBe(1);
      expect(saved).toEqual([]);
      expect(lines.join("\n")).toBe('"_nda_inbox" is not a locked folder of the mailbox "main". Locked folders: _NDA_Inbox. Write it exactly as listed there. Nothing was changed.');
    });

    it("says so in German when nothing is locked", async () => {
      const { d, lines, saved } = deps(base(), { locale: "de" });
      expect(await runAccountsEdit(edit(["main", "--unlock-folder", "_NDA_Inbox"]), d)).toBe(1);
      expect(saved).toEqual([]);
      expect(lines.join("\n")).toMatch(/„_NDA_Inbox“ ist im Postfach „main“ nicht gesperrt\. Gesperrte Ordner: keine\..*Nichts wurde geändert\./);
    });

    it("reports a lock in German", async () => {
      const { d, lines } = deps(base(), { locale: "de" });
      expect(await runAccountsEdit(edit(["main", "--lock-folder", "_NDA_Inbox"]), d)).toBe(0);
      expect(lines.join("\n")).toContain("gesperrte Ordner: keine → _NDA_Inbox");
    });
  });

  it("explains that there is no config file yet", async () => {
    const { d, lines } = deps(null);
    expect(await runAccountsEdit(edit(["main", "--default"]), d)).toBe(1);
    expect(lines.join("\n")).toMatch(/setup/);
  });
});
