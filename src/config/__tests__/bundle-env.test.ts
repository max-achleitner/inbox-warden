import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { BundleConfigError, applyBundleArgs, applyBundleEnv } from "../bundle-env.js";
import { loadConfig } from "../load.js";
import { createSecretStore } from "../../secrets/store.js";
import { detectProvider, withDetectedEndpoints, type TextFetch } from "../../onboarding/autoconfig.js";

describe("applyBundleEnv", () => {
  it("drops unresolved MCPB placeholders and empty values", () => {
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_USERNAME: "${user_config.username}",
      IMAP_MCP_IMAP_HOST: "  ",
      IMAP_MCP_DISPLAY_NAME: "",
      IMAP_MCP_OAUTH_TENANT: "${user_config.oauth_tenant}",
      IMAP_MCP_PASSWORD: "${user_config.password}",
      IMAP_MCP_DENY_FOLDERS: "${user_config.locked_folders}",
      IMAP_PASSWORD: "",
    };
    applyBundleEnv(env);
    expect(env).toEqual({});
  });

  it("trims values but never secrets", () => {
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_EMAIL: " max@firma.example ",
      IMAP_MCP_PASSWORD: " pass with spaces ",
      IMAP_MCP_OAUTH_CLIENT_SECRET: " GOCSPX-secret ",
    };
    applyBundleEnv(env);
    expect(env).toEqual({
      IMAP_MCP_EMAIL: "max@firma.example",
      IMAP_MCP_PASSWORD: " pass with spaces ",
      IMAP_MCP_OAUTH_CLIENT_SECRET: " GOCSPX-secret ",
    });
  });

  it("leaves variables of other programs alone", () => {
    const env: NodeJS.ProcessEnv = { PATH: "${not-ours}", HOME: "" };
    applyBundleEnv(env);
    expect(env).toEqual({ PATH: "${not-ours}", HOME: "" });
  });

  it("treats port 0 as automatic and rejects impossible ports", () => {
    const env: NodeJS.ProcessEnv = { IMAP_MCP_IMAP_PORT: "0", IMAP_MCP_SMTP_PORT: "587" };
    applyBundleEnv(env);
    expect(env).toEqual({ IMAP_MCP_SMTP_PORT: "587" });
    expect(() => applyBundleEnv({ IMAP_MCP_IMAP_PORT: "99999" })).toThrow(BundleConfigError);
    expect(() => applyBundleEnv({ IMAP_MCP_SMTP_PORT: "smtp" })).toThrow(/SMTP port must be a number/);
  });

  it("normalises the permission list and names unknown entries", () => {
    const env: NodeJS.ProcessEnv = { IMAP_MCP_PERMISSIONS: "Write, read ;READ" };
    applyBundleEnv(env);
    expect(env.IMAP_MCP_PERMISSIONS).toBe("read,write");
    expect(() => applyBundleEnv({ IMAP_MCP_PERMISSIONS: "read,admin" })).toThrow(/"admin" is not one of them/);
  });

  it("validates send mode, sent copy and language case-insensitively", () => {
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_SEND_MODE: "Confirm",
      IMAP_MCP_SENT_COPY: "AUTO",
      IMAP_MCP_LOCALE: "DE",
      IMAP_MCP_LANG: "DE",
    };
    applyBundleEnv(env);
    expect(env).toEqual({ IMAP_MCP_SEND_MODE: "confirm", IMAP_MCP_SENT_COPY: "auto", IMAP_MCP_LOCALE: "de", IMAP_MCP_LANG: "de" });
    expect(() => applyBundleEnv({ IMAP_MCP_SEND_MODE: "yes" })).toThrow(/drafts-only, confirm, direct/);
    expect(() => applyBundleEnv({ IMAP_MCP_LOCALE: "fr" })).toThrow(/Language must be one of de, en/);
  });

  it("accepts the three sign-in methods case-insensitively", () => {
    const env: NodeJS.ProcessEnv = { IMAP_MCP_AUTH: "Microsoft" };
    applyBundleEnv(env);
    expect(env.IMAP_MCP_AUTH).toBe("microsoft");
    expect(() => applyBundleEnv({ IMAP_MCP_AUTH: "kerberos" })).toThrow(
      /Sign-in method must be one of password, microsoft, google/,
    );
  });

  it("turns the server-lookup switch into IMAP_MCP_NO_AUTOCONFIG", () => {
    const on: NodeJS.ProcessEnv = { IMAP_MCP_NO_AUTOCONFIG: "true" };
    applyBundleEnv(on);
    expect(on).toEqual({ IMAP_MCP_NO_AUTOCONFIG: "1" });
    const off: NodeJS.ProcessEnv = { IMAP_MCP_NO_AUTOCONFIG: "false" };
    applyBundleEnv(off);
    expect(off).toEqual({});
    expect(() => applyBundleEnv({ IMAP_MCP_NO_AUTOCONFIG: "maybe" })).toThrow(
      /"Advanced: don't look up servers online" must be on or off — not "maybe"/,
    );
    const mixed: NodeJS.ProcessEnv = { IMAP_MCP_NO_AUTOCONFIG: "TRUE" };
    applyBundleEnv(mixed);
    expect(mixed).toEqual({ IMAP_MCP_NO_AUTOCONFIG: "1" });
  });

  it("maps the two switches onto permissions", () => {
    const sendOnly: NodeJS.ProcessEnv = { IMAP_MCP_ALLOW_SEND: "true", IMAP_MCP_ALLOW_DELETE: "false" };
    applyBundleEnv(sendOnly);
    expect(sendOnly).toEqual({ IMAP_MCP_PERMISSIONS: "read,write,send" });
    const none: NodeJS.ProcessEnv = { IMAP_MCP_ALLOW_SEND: "false", IMAP_MCP_ALLOW_DELETE: "False" };
    applyBundleEnv(none);
    expect(none).toEqual({ IMAP_MCP_PERMISSIONS: "read,write" });
    const del: NodeJS.ProcessEnv = { IMAP_MCP_ALLOW_DELETE: "1" };
    applyBundleEnv(del);
    expect(del).toEqual({ IMAP_MCP_PERMISSIONS: "read,write,delete" });
    const both: NodeJS.ProcessEnv = { IMAP_MCP_ALLOW_SEND: "TRUE", IMAP_MCP_ALLOW_DELETE: "1" };
    applyBundleEnv(both);
    expect(both).toEqual({ IMAP_MCP_PERMISSIONS: "read,write,send,delete" });
  });

  it("treats an unexpanded switch as off", () => {
    const env: NodeJS.ProcessEnv = { IMAP_MCP_ALLOW_SEND: "${user_config.allow_send}" };
    applyBundleEnv(env);
    expect(env).toEqual({ IMAP_MCP_PERMISSIONS: "read,write" });
  });

  it("refuses a switch value that is neither on nor off", () => {
    expect(() => applyBundleEnv({ IMAP_MCP_ALLOW_SEND: "maybe" })).toThrow(
      /"Claude may send email" must be on or off — not "maybe"/,
    );
    expect(() => applyBundleEnv({ IMAP_MCP_ALLOW_DELETE: "yes" })).toThrow(
      /"Claude may move email to Trash" must be on or off — not "yes"/,
    );
  });

  it("lets explicit permissions win over the switches", () => {
    const env: NodeJS.ProcessEnv = { IMAP_MCP_PERMISSIONS: "read", IMAP_MCP_ALLOW_SEND: "true" };
    applyBundleEnv(env);
    expect(env).toEqual({ IMAP_MCP_PERMISSIONS: "read" });
  });

  it.each([
    ["imap.example.com:143", "imap.example.com", "143"],
    ["[2001:db8::1]:993", "2001:db8::1", "993"],
    ["2001:db8::1", "2001:db8::1", undefined],
    ["[2001:db8::1]", "2001:db8::1", undefined],
    [" imap.example.com ", "imap.example.com", undefined],
    ["imap.example.com", "imap.example.com", undefined],
  ])("splits server:port in %j", (value, host, port) => {
    const env: NodeJS.ProcessEnv = { IMAP_MCP_IMAP_HOST: value };
    applyBundleEnv(env);
    expect(env.IMAP_MCP_IMAP_HOST).toBe(host);
    expect(env.IMAP_MCP_IMAP_PORT).toBe(port);
  });

  it("splits the SMTP server too", () => {
    const env: NodeJS.ProcessEnv = { IMAP_MCP_SMTP_HOST: "smtp.example.com:587" };
    applyBundleEnv(env);
    expect(env).toEqual({ IMAP_MCP_SMTP_HOST: "smtp.example.com", IMAP_MCP_SMTP_PORT: "587" });
  });

  it("accepts a port that matches the port field and refuses one that differs", () => {
    const same: NodeJS.ProcessEnv = { IMAP_MCP_IMAP_HOST: "a.example:143", IMAP_MCP_IMAP_PORT: "143" };
    applyBundleEnv(same);
    expect(same).toEqual({ IMAP_MCP_IMAP_HOST: "a.example", IMAP_MCP_IMAP_PORT: "143" });
    expect(() => applyBundleEnv({ IMAP_MCP_IMAP_HOST: "a.example:143", IMAP_MCP_IMAP_PORT: "995" })).toThrow(
      /143.*995|995.*143/,
    );
    // "0" means automatic and is dropped before the comparison
    const auto: NodeJS.ProcessEnv = { IMAP_MCP_IMAP_HOST: "a.example:143", IMAP_MCP_IMAP_PORT: "0" };
    applyBundleEnv(auto);
    expect(auto).toEqual({ IMAP_MCP_IMAP_HOST: "a.example", IMAP_MCP_IMAP_PORT: "143" });
  });

  it("refuses a broken server:port", () => {
    for (const value of ["host:", ":993", "host:99999", "host:abc", "host:0", "[::1]:", "[::1", "[]:993"]) {
      expect(() => applyBundleEnv({ IMAP_MCP_IMAP_HOST: value }), value).toThrow(
        /"Advanced: incoming server \(IMAP\)" must be a server name/,
      );
    }
    expect(() => applyBundleEnv({ IMAP_MCP_SMTP_HOST: "host:" })).toThrow(
      /"Advanced: outgoing server \(SMTP\)" must be a server name, optionally with :port \(1–65535\) — not "host:"/,
    );
  });

  it("cleans the attachment folder list", () => {
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_ATTACHMENT_DIRS: ["${user_config.attachment_dirs}", " /data/angebote ", "", "/data/rechnungen"].join(delimiter),
      IMAP_MCP_DOWNLOAD_DIR: "${user_config.download_dir}",
    };
    applyBundleEnv(env);
    expect(env).toEqual({ IMAP_MCP_ATTACHMENT_DIRS: ["/data/angebote", "/data/rechnungen"].join(delimiter) });
    const empty: NodeJS.ProcessEnv = { IMAP_MCP_ATTACHMENT_DIRS: delimiter };
    applyBundleEnv(empty);
    expect(empty).toEqual({});
  });

  it("asks for the password only when a form left it empty for password sign-in", () => {
    expect(() =>
      applyBundleEnv({ IMAP_MCP_EMAIL: "max@firma.example", IMAP_MCP_PASSWORD: "${user_config.password}" }),
    ).toThrow(/Enter the password \(or app password\) for max@firma.example in the settings\./);
    // Microsoft 365 / Google sign-in needs no password
    expect(() =>
      applyBundleEnv({ IMAP_MCP_EMAIL: "office@firma.at", IMAP_MCP_PASSWORD: "", IMAP_MCP_AUTH: "microsoft" }),
    ).not.toThrow();
    // A hand-written config without the variable may rely on the keychain or a secret file
    expect(() => applyBundleEnv({ IMAP_MCP_EMAIL: "office@firma.at" })).not.toThrow();
    expect(() =>
      applyBundleEnv({ IMAP_MCP_EMAIL: "office@firma.at", IMAP_MCP_PASSWORD: "", IMAP_MCP_PASSWORD_FILE: "/run/secrets/mail" }),
    ).not.toThrow();
    // A config file takes precedence over env-only mode
    expect(() =>
      applyBundleEnv({ IMAP_MCP_EMAIL: "office@firma.at", IMAP_MCP_PASSWORD: "", IMAP_MCP_CONFIG: "/etc/imap-mcp.json" }),
    ).not.toThrow();
  });
});

describe("applyBundleArgs", () => {
  it("turns MCPB's expanded folder list into IMAP_MCP_ATTACHMENT_DIRS and returns the other arguments", () => {
    const env: NodeJS.ProcessEnv = {};
    const rest = applyBundleArgs(["--attachment-dirs", "C:\\Users\\Max Müller\\Angebote", "D:\\Rechnungen", "--http"], env);
    expect(rest).toEqual(["--http"]);
    expect(env.IMAP_MCP_ATTACHMENT_DIRS).toBe(["C:\\Users\\Max Müller\\Angebote", "D:\\Rechnungen"].join(delimiter));
  });

  it("ignores the placeholder of a field the user left empty", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyBundleArgs(["--attachment-dirs", "${user_config.attachment_dirs}"], env)).toEqual([]);
    expect(applyBundleArgs(["--attachment-dirs"], env)).toEqual([]);
    expect(env).toEqual({});
  });

  it("keeps an explicitly set IMAP_MCP_ATTACHMENT_DIRS and leaves other arguments alone", () => {
    const env: NodeJS.ProcessEnv = { IMAP_MCP_ATTACHMENT_DIRS: "/srv/files" };
    applyBundleArgs(["--attachment-dirs", "/other"], env);
    expect(env.IMAP_MCP_ATTACHMENT_DIRS).toBe("/srv/files");
    expect(applyBundleArgs(["--http"], env)).toEqual(["--http"]);
  });
});

describe("Claude Desktop form → env-only config (contract with Plans 2 and 4)", () => {
  const home = () => mkdtempSync(join(tmpdir(), "inbox-warden-home-"));

  it("turns a password form into a working env-only account", async () => {
    const homeDir = home();
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_HOME: homeDir,
      IMAP_MCP_DOWNLOAD_DIR: join(homeDir, "Downloads"),
      IMAP_MCP_EMAIL: "max@firma.example",
      IMAP_MCP_AUTH: "password",
      IMAP_MCP_PASSWORD: "app-password",
      IMAP_MCP_USERNAME: "${user_config.username}",
      IMAP_MCP_DISPLAY_NAME: "Maximilian Achleitner",
      IMAP_MCP_IMAP_HOST: "mail.firma.example",
      IMAP_MCP_IMAP_PORT: "${user_config.imap_port}",
      IMAP_MCP_SMTP_HOST: "mail.firma.example",
      IMAP_MCP_SMTP_PORT: "${user_config.smtp_port}",
      IMAP_MCP_PERMISSIONS: "read,write",
      IMAP_MCP_SEND_MODE: "confirm",
      IMAP_MCP_DENY_FOLDERS: " _NDA_Inbox, _NDA_* ",
      IMAP_MCP_LOCALE: "de",
    };
    applyBundleEnv(env);
    applyBundleArgs(["--attachment-dirs", join(homeDir, "Angebote")], env);
    const config = await loadConfig(env, { secrets: createSecretStore(env, { keychain: false }) });

    expect(config.files).toMatchObject({ attachmentDirs: [join(homeDir, "Angebote")], downloadDir: join(homeDir, "Downloads") });
    expect(config.accounts).toHaveLength(1);
    const account = config.accounts[0];
    expect(account).toMatchObject({
      id: "main",
      email: "max@firma.example",
      imap: { host: "mail.firma.example", port: 993 },
      smtp: { host: "mail.firma.example", port: 465 },
      permissions: { read: true, write: true, send: false, delete: false },
      locale: "de",
    });
    expect(account.policy.send.mode).toBe("confirm");
    expect(account.policy.folders.deny).toEqual(["_NDA_Inbox", "_NDA_*"]);
    expect(account.auth).toEqual({ type: "password" });
    expect(account.identities[0]).toMatchObject({ email: "max@firma.example", name: "Maximilian Achleitner" });
    expect(await createSecretStore(env, { keychain: false }).get("main", "password")).toBe("app-password");
  });

  it("turns a Microsoft 365 form (no password, no servers) into an OAuth account", async () => {
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_HOME: home(),
      IMAP_MCP_EMAIL: "office@firma-beispiel.at",
      IMAP_MCP_AUTH: "microsoft",
      IMAP_MCP_PASSWORD: "${user_config.password}",
      IMAP_MCP_OAUTH_CLIENT_ID: "${user_config.oauth_client_id}",
      IMAP_MCP_OAUTH_TENANT: "${user_config.oauth_tenant}",
      IMAP_MCP_OAUTH_CLIENT_SECRET: "${user_config.oauth_client_secret}",
      IMAP_MCP_IMAP_HOST: "${user_config.imap_host}",
      IMAP_MCP_IMAP_PORT: "${user_config.imap_port}",
      IMAP_MCP_SMTP_HOST: "${user_config.smtp_host}",
      IMAP_MCP_SMTP_PORT: "${user_config.smtp_port}",
      IMAP_MCP_NO_AUTOCONFIG: "false",
      IMAP_MCP_DENY_FOLDERS: "${user_config.locked_folders}",
      IMAP_MCP_PERMISSIONS: "read,write",
    };
    applyBundleEnv(env);
    expect(env.IMAP_MCP_DENY_FOLDERS).toBeUndefined();

    // What serve() does next (Plan 4): fill the servers from the domain's MX record — injected here
    // instead of a real DNS lookup.
    const detect = (email: string) =>
      detectProvider(email, {
        resolveMx: async () => [{ exchange: "firma-beispiel-at.mail.protection.outlook.com", priority: 0 }],
        fetch: (async () => ({ status: 404, text: async () => "" })) as TextFetch,
      });
    const detected = await withDetectedEndpoints(env, detect);
    const config = await loadConfig(detected, { secrets: createSecretStore(detected, { keychain: false }) });

    const account = config.accounts[0];
    expect(account.auth).toEqual({ type: "oauth2", provider: "microsoft" });
    expect(account).toMatchObject({
      id: "main",
      email: "office@firma-beispiel.at",
      imap: { host: "outlook.office365.com", port: 993 },
      smtp: { host: "smtp.office365.com", port: 587 },
    });
    expect(account.policy.folders.deny).toEqual([]);
  });
});
