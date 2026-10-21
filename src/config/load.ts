import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { ConfigSchema, type AppConfig, type PermissionTier } from "./schema.js";
import { FolderPolicySchema } from "../policy/schema.js";
import type { SecretStore } from "../secrets/store.js";
import {
  deleteLegacyKeytarPassword,
  loadKeytarReader,
  lookupLegacyKeytarPassword,
  type KeytarReader,
} from "../secrets/keytar-migration.js";
import * as log from "../logging/logger.js";
import { authFromEnv } from "./env-auth.js";
import { SERVER_NAME } from "../version.js";
import { detectLocale } from "../cli/messages.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

/** ~/.imap-mcp unless IMAP_MCP_HOME is set. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env.IMAP_MCP_HOME) ?? path.join(os.homedir(), ".imap-mcp");
}

export const CONFIG_DIR = configDir();

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env.IMAP_MCP_CONFIG) ?? path.join(configDir(env), "config.json");
}

function parseConfig(raw: unknown, source: string): AppConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration in ${source}:\n${z.prettifyError(result.error)}\nRun "${SERVER_NAME} setup" to repair it.`);
  }
  return result.data;
}

const TIERS: PermissionTier[] = ["read", "write", "send", "delete"];

function parsePermissions(value: string | undefined): Record<PermissionTier, boolean> {
  const listed = (value ?? "read,write").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const item of listed) {
    if (!TIERS.includes(item as PermissionTier)) {
      throw new ConfigError(`IMAP_MCP_PERMISSIONS contains "${item}". Allowed: ${TIERS.join(", ")}.`);
    }
  }
  return { read: listed.includes("read"), write: listed.includes("write"), send: listed.includes("send"), delete: listed.includes("delete") };
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`${name} must be a port number between 1 and 65535.`);
  return port;
}

/** files settings for env-only mode (MCPB bundles, containers). */
export function filesFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const attachmentDirs = (env.IMAP_MCP_ATTACHMENT_DIRS ?? "")
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
  const downloadDir = env.IMAP_MCP_DOWNLOAD_DIR?.trim();
  return {
    ...(attachmentDirs.length > 0 ? { attachmentDirs } : {}),
    ...(downloadDir ? { downloadDir } : {}),
  };
}

/**
 * IMAP_MCP_DENY_FOLDERS (the extension's "Locked folders (comma-separated)"): comma-separated folder
 * patterns that become policy.folders.deny. Checked against the policy schema here, so a mistake
 * names the variable instead of a config path. A folder name with a comma cannot be written here
 * ("?" in its place works, or --lock-folder / config.json).
 */
export function denyFoldersFromEnv(env: NodeJS.ProcessEnv): string[] {
  const deny = (env.IMAP_MCP_DENY_FOLDERS ?? "")
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  const problem = (detail: string) =>
    new ConfigError(
      `Locked folders (IMAP_MCP_DENY_FOLDERS): ${detail} Write the folder names separated by commas, without quotation marks, e.g. _NDA_Inbox, _NDA_*`,
    );
  // Quotation marks are refused on purpose: the guide shows the config.json form
  // ["_NDA_Inbox", "_NDA_Projekt"], and pasted into the form field its quotes (and brackets) would
  // be matched literally, so the lock would silently cover no folder. The extension has no doctor
  // run to catch that, so failing at start-up is the only signal. A folder whose name really
  // contains a quotation mark (very rare) can still be locked with "?" in its place.
  const quoted = deny.find((pattern) => pattern.includes('"'));
  if (quoted !== undefined) throw problem(`${quoted} contains quotation marks.`);
  const checked = FolderPolicySchema.safeParse({ deny });
  if (!checked.success) throw problem(`${checked.error.issues.map((issue) => issue.message).join("; ")}.`);
  return checked.data.deny;
}

/** Single-account configuration from IMAP_MCP_* variables (Claude Desktop bundles, containers). */
export function configFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const email = nonEmpty(env.IMAP_MCP_EMAIL)!;
  const imapHost = nonEmpty(env.IMAP_MCP_IMAP_HOST);
  if (!imapHost) {
    throw new ConfigError(
      `No incoming mail server (IMAP) is known for ${email}. Enter it under "Advanced: incoming server (IMAP)", or switch off "Advanced: don't look up servers online" so it can be detected. (IMAP_MCP_IMAP_HOST is not set.)`,
    );
  }
  const smtpHost = nonEmpty(env.IMAP_MCP_SMTP_HOST);
  const username = nonEmpty(env.IMAP_MCP_USERNAME);
  const name = nonEmpty(env.IMAP_MCP_DISPLAY_NAME);
  const sendMode = nonEmpty(env.IMAP_MCP_SEND_MODE);
  const deny = denyFoldersFromEnv(env);
  const policy = {
    ...(sendMode ? { send: { mode: sendMode } } : {}),
    ...(deny.length > 0 ? { folders: { deny } } : {}),
  };
  return parseConfig(
    {
      version: 2,
      files: filesFromEnv(env),
      accounts: [
        {
          id: "main",
          email,
          imap: { host: imapHost, port: parsePort(nonEmpty(env.IMAP_MCP_IMAP_PORT), 993, "IMAP_MCP_IMAP_PORT") },
          ...(smtpHost ? { smtp: { host: smtpHost, port: parsePort(nonEmpty(env.IMAP_MCP_SMTP_PORT), 465, "IMAP_MCP_SMTP_PORT") } } : {}),
          auth: authFromEnv(env, username),
          identities: name ? [{ email, name }] : [],
          permissions: parsePermissions(nonEmpty(env.IMAP_MCP_PERMISSIONS)),
          ...(nonEmpty(env.IMAP_MCP_SENT_COPY) ? { sentCopy: nonEmpty(env.IMAP_MCP_SENT_COPY) } : {}),
          locale: nonEmpty(env.IMAP_MCP_LOCALE) ?? detectLocale(env),
          ...(Object.keys(policy).length > 0 ? { policy } : {}),
        },
      ],
    },
    "environment variables",
  );
}

interface V1Config {
  imapHost: string;
  imapPort: number;
  smtpHost?: string;
  smtpPort?: number;
  user: string;
  password?: string;
  permissions?: Partial<Record<PermissionTier, boolean>>;
  sentCopy?: string;
}

function isV1(raw: unknown): raw is V1Config {
  return typeof raw === "object" && raw !== null && !("version" in raw) && "imapHost" in raw;
}

/** Convert a v0.1/v0.2 single-account file into the v2 shape (account id "main"). */
export function migrateV1(v1: V1Config): AppConfig {
  if (!/^[^@\s]+@[^@\s]+$/.test(v1.user ?? "")) {
    throw new ConfigError(`The old configuration uses the login "${v1.user}", which is not an email address. Run "${SERVER_NAME} setup" to set up the account again.`);
  }
  return parseConfig(
    {
      version: 2,
      accounts: [
        {
          id: "main",
          email: v1.user,
          imap: { host: v1.imapHost, port: v1.imapPort },
          ...(v1.smtpHost ? { smtp: { host: v1.smtpHost, port: v1.smtpPort ?? 465 } } : {}),
          // Sending and deleting were set in a version without policy rules or confirmations: turn them on again on purpose
          permissions: { ...v1.permissions, send: false, delete: false },
          ...(v1.sentCopy ? { sentCopy: v1.sentCopy } : {}),
        },
      ],
    },
    "the old configuration file",
  );
}

/** Write atomically with owner-only permissions. */
export async function saveConfig(config: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = configFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ConfigSchema.parse(config), null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) {
      // JSON.parse quotes part of the file in its message; a corrupt config may hold a password, so keep only the location.
      const where = /line \d+ column \d+|position \d+/.exec(err.message)?.[0];
      throw new ConfigError(`Could not read ${file}: it is not valid JSON${where ? ` (${where})` : ""}.`);
    }
    throw new ConfigError(`Could not read ${file}: ${(err as Error).message}`);
  }
}

/**
 * Load the configuration:
 *   1. IMAP_MCP_CONFIG (explicit file), else
 *   2. IMAP_MCP_EMAIL set → environment-only single account, else
 *   3. <config dir>/config.json, falling back to the legacy credentials.json.
 * Old (v1) files are migrated to v2, rewritten and backed up without the password; a plaintext or
 * legacy-keychain password moves into the secret store. The file is only rewritten once the
 * password is safe: without a secret store, or when the old keychain cannot be read here, the
 * migration happens in memory only.
 */
export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { secrets?: SecretStore; legacyKeytar?: () => Promise<KeytarReader | null> } = {},
): Promise<AppConfig> {
  const explicit = nonEmpty(env.IMAP_MCP_CONFIG);
  if (!explicit && nonEmpty(env.IMAP_MCP_EMAIL)) return configFromEnv(env);

  const dir = configDir(env);
  const file = configFilePath(env);
  const legacyFile = path.join(dir, "credentials.json");
  const source = fs.existsSync(file) ? file : !explicit && fs.existsSync(legacyFile) ? legacyFile : null;
  if (!source) {
    throw new ConfigError(`No configuration found at ${file}. Run "${SERVER_NAME} setup" to configure your mail account.`);
  }

  const raw = readJson(source);
  if (!isV1(raw)) return parseConfig(raw, source);

  const config = migrateV1(raw);
  // Read-only callers (audit verify) pass no store: rewriting would drop the password
  if (!opts.secrets) return config;

  const loadReader = opts.legacyKeytar ?? loadKeytarReader;
  let password = raw.password;
  let fromKeytar = false;
  if (!password) {
    const legacy = await lookupLegacyKeytarPassword(raw.user, loadReader);
    if (legacy.status === "unknown") {
      // The v0.1 entry may exist but is unreadable here; after a rewrite nothing would look for it again
      log.warn("config.migration_deferred", { reason: "the old keychain entry cannot be read in this environment" });
      return config;
    }
    if (legacy.status === "found") {
      password = legacy.password;
      fromKeytar = true;
    }
  }
  if (password) await opts.secrets.set("main", "password", password);

  const { password: _dropped, ...withoutPassword } = raw;
  fs.writeFileSync(path.join(dir, "config.v1.backup.json"), JSON.stringify(withoutPassword, null, 2), { mode: 0o600 });
  await saveConfig(config, { ...env, IMAP_MCP_CONFIG: file });
  if (source === legacyFile) fs.unlinkSync(legacyFile);
  if (fromKeytar) await deleteLegacyKeytarPassword(raw.user, loadReader);
  log.info("config.migrated", { from: "v1", to: "v2", accounts: ["main"] });
  return config;
}
