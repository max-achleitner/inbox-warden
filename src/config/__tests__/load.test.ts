import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigError, configFromEnv, loadConfig, saveConfig } from "../load.js";
import type { SecretKey, SecretStore } from "../../secrets/store.js";

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();
  async get(accountId: string, key: SecretKey) {
    return this.values.get(`${accountId}:${key}`) ?? null;
  }
  async set(accountId: string, key: SecretKey, value: string) {
    this.values.set(`${accountId}:${key}`, value);
  }
  async delete(accountId: string, key: SecretKey) {
    this.values.delete(`${accountId}:${key}`);
  }
}

describe("loadConfig", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-"));
    env = { IMAP_MCP_HOME: dir };
  });

  it("does not quote a corrupt config file in the error", async () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, '{"password": hunter2secret}');
    const err = await loadConfig(env, { secrets: new MemorySecrets() }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(file);
    expect((err as Error).message).toContain("not valid JSON");
    expect((err as Error).message).not.toContain("hunter2");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("explains how to start when nothing is configured", async () => {
    await expect(loadConfig(env)).rejects.toThrow(/No configuration found.*inbox-warden setup/);
  });

  it("migrates a v1 file with a plaintext password: secret moves to the store, backup has no password", async () => {
    fs.writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({
        imapHost: "mail.firma.example",
        imapPort: 143,
        smtpHost: "mail.firma.example",
        smtpPort: 587,
        user: "max@firma.example",
        password: "hunter2",
      }),
    );
    const secrets = new MemorySecrets();

    const config = await loadConfig(env, { secrets });

    expect(config.accounts[0]).toMatchObject({
      id: "main",
      email: "max@firma.example",
      imap: { host: "mail.firma.example", port: 143 },
      smtp: { host: "mail.firma.example", port: 587 },
      permissions: { read: true, write: true, send: false, delete: false },
    });
    expect(await secrets.get("main", "password")).toBe("hunter2");
    expect(fs.existsSync(path.join(dir, "credentials.json"))).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(saved.version).toBe(2);
    const backup = fs.readFileSync(path.join(dir, "config.v1.backup.json"), "utf8");
    expect(backup).not.toContain("hunter2");
  });

  it("switches send and delete off for a migrated mailbox, keeps reading and organising as they were", async () => {
    fs.writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({
        imapHost: "mail.firma.example",
        imapPort: 993,
        user: "max@firma.example",
        password: "hunter2",
        permissions: { read: true, write: false, send: true, delete: true },
      }),
    );
    const config = await loadConfig(env, { secrets: new MemorySecrets() });
    expect(config.accounts[0].permissions).toEqual({ read: true, write: false, send: false, delete: false });
  });

  describe("never loses the v1 password", () => {
    const v1 = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({ imapHost: "mail.example.com", imapPort: 993, user: "max@example.com", ...extra });
    const legacy = (entries: Record<string, string>) => async () => ({
      removed: [] as string[],
      async read(l: { service: string; account: string }) {
        return entries[`${l.service}|${l.account}`] ?? null;
      },
      async remove() {},
    });

    it("without a secret store (e.g. audit verify) it migrates in memory and leaves the file alone", async () => {
      const original = v1({ password: "hunter2" });
      fs.writeFileSync(path.join(dir, "credentials.json"), original);
      const config = await loadConfig(env);
      expect(config.accounts[0].email).toBe("max@example.com");
      expect(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")).toBe(original);
      expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
    });

    it("waits when the old keychain cannot be read here (bundle without keytar)", async () => {
      const original = v1();
      fs.writeFileSync(path.join(dir, "credentials.json"), original);
      const secrets = new MemorySecrets();
      await loadConfig(env, { secrets, legacyKeytar: async () => null });
      expect(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")).toBe(original);
      expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
    });

    it("moves a password from the old keychain entry, then rewrites", async () => {
      fs.writeFileSync(path.join(dir, "credentials.json"), v1());
      const secrets = new MemorySecrets();
      await loadConfig(env, { secrets, legacyKeytar: legacy({ "imap-mcp-server|max@example.com": "v01-pw" }) });
      expect(await secrets.get("main", "password")).toBe("v01-pw");
      expect(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).version).toBe(2);
    });

    it("rewrites when the old keychain is readable and has no entry (nothing to lose)", async () => {
      fs.writeFileSync(path.join(dir, "credentials.json"), v1());
      await loadConfig(env, { secrets: new MemorySecrets(), legacyKeytar: legacy({}) });
      expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true);
    });

    it("leaves the file alone when storing the password fails", async () => {
      const original = v1({ password: "hunter2" });
      fs.writeFileSync(path.join(dir, "credentials.json"), original);
      const secrets = new MemorySecrets();
      secrets.set = async () => {
        throw new Error("keychain locked");
      };
      await expect(loadConfig(env, { secrets })).rejects.toThrow(/keychain locked/);
      expect(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")).toBe(original);
    });
  });

  it("explains a missing incoming server in the form's words", () => {
    let message = "";
    try {
      configFromEnv({ IMAP_MCP_EMAIL: "a@example.invalid", IMAP_MCP_PASSWORD: "x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/No incoming mail server \(IMAP\) is known for a@example\.invalid/);
    expect(message).toMatch(/Advanced: incoming server \(IMAP\)/);
    expect(message).toMatch(/don't look up servers online/);
    expect(message).toMatch(/IMAP_MCP_IMAP_HOST/);
  });

  it("uses the system language when none is set", () => {
    const base = { IMAP_MCP_EMAIL: "a@example.com", IMAP_MCP_IMAP_HOST: "imap.example.com" };
    expect(configFromEnv({ ...base, LANG: "de_AT.UTF-8" }).accounts[0].locale).toBe("de");
    expect(configFromEnv({ ...base, LANG: "de_AT.UTF-8", IMAP_MCP_LOCALE: "en" }).accounts[0].locale).toBe("en");
  });

  it("loads an existing v2 file unchanged", async () => {
    const config = configFromEnv({ IMAP_MCP_EMAIL: "a@example.com", IMAP_MCP_IMAP_HOST: "imap.example.com" });
    await saveConfig(config, env);
    expect(await loadConfig(env)).toEqual(config);
  });

  it("reports schema problems with the field path", async () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 2, accounts: [{ id: "main", email: "x", imap: { host: "h", port: 0 } }] }));
    await expect(loadConfig(env)).rejects.toThrow(ConfigError);
    await expect(loadConfig(env)).rejects.toThrow(/accounts/);
  });

  it("uses environment-only mode when IMAP_MCP_EMAIL is set", async () => {
    const config = await loadConfig({
      ...env,
      IMAP_MCP_EMAIL: "office@firma.at",
      IMAP_MCP_DISPLAY_NAME: "Firma GmbH",
      IMAP_MCP_IMAP_HOST: "imap.firma.at",
      IMAP_MCP_SMTP_HOST: "smtp.firma.at",
      IMAP_MCP_SMTP_PORT: "587",
      IMAP_MCP_PERMISSIONS: "read,write,send",
      IMAP_MCP_LOCALE: "de",
      IMAP_MCP_SENT_COPY: "",
    });
    expect(config.accounts[0]).toMatchObject({
      id: "main",
      email: "office@firma.at",
      imap: { host: "imap.firma.at", port: 993 },
      smtp: { host: "smtp.firma.at", port: 587 },
      identities: [{ email: "office@firma.at", name: "Firma GmbH" }],
      permissions: { read: true, write: true, send: true, delete: false },
      locale: "de",
      sentCopy: "auto",
    });
  });

  describe("locked folders in environment mode (IMAP_MCP_DENY_FOLDERS)", () => {
    const base = { IMAP_MCP_EMAIL: "a@example.com", IMAP_MCP_IMAP_HOST: "imap.example.com" };

    it("turns the comma-separated list into policy.folders.deny, trimmed and without empty entries", () => {
      const config = configFromEnv({ ...base, IMAP_MCP_DENY_FOLDERS: " _NDA_Inbox ,, Projekte/_NDA_* ," });
      expect(config.accounts[0].policy.folders).toEqual({ deny: ["_NDA_Inbox", "Projekte/_NDA_*"] });
    });

    it("locks nothing when the variable is unset, empty or only commas", () => {
      for (const value of [undefined, "", " , ,"]) {
        expect(configFromEnv({ ...base, IMAP_MCP_DENY_FOLDERS: value }).accounts[0].policy.folders).toEqual({ deny: [] });
      }
    });

    it("keeps the send mode next to the folder lock", () => {
      const config = configFromEnv({ ...base, IMAP_MCP_SEND_MODE: "drafts-only", IMAP_MCP_DENY_FOLDERS: "_NDA_Inbox" });
      expect(config.accounts[0].policy.send.mode).toBe("drafts-only");
      expect(config.accounts[0].policy.folders.deny).toEqual(["_NDA_Inbox"]);
      expect(configFromEnv({ ...base, IMAP_MCP_SEND_MODE: "direct" }).accounts[0].policy.send.mode).toBe("direct");
    });

    it("refuses quoted names, which would lock nothing, and names the variable", () => {
      for (const value of ['"_NDA_Inbox"', '["_NDA_Inbox", "_NDA_Projekt"]']) {
        expect(() => configFromEnv({ ...base, IMAP_MCP_DENY_FOLDERS: value })).toThrow(ConfigError);
        expect(() => configFromEnv({ ...base, IMAP_MCP_DENY_FOLDERS: value })).toThrow(/IMAP_MCP_DENY_FOLDERS.*quotation marks/);
      }
    });

    it("is applied by loadConfig in environment-only mode", async () => {
      const config = await loadConfig({ ...env, ...base, IMAP_MCP_DENY_FOLDERS: "_NDA_Inbox" });
      expect(config.accounts[0].policy.folders.deny).toEqual(["_NDA_Inbox"]);
    });
  });

  it("rejects unknown permission names in environment mode", () => {
    expect(() => configFromEnv({ IMAP_MCP_EMAIL: "a@example.com", IMAP_MCP_IMAP_HOST: "h", IMAP_MCP_PERMISSIONS: "read,admin" })).toThrow(/admin/);
  });

  it("saves the file with owner-only permissions", async () => {
    await saveConfig(configFromEnv({ IMAP_MCP_EMAIL: "a@example.com", IMAP_MCP_IMAP_HOST: "h" }), env);
    const mode = fs.statSync(path.join(dir, "config.json")).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });
});
