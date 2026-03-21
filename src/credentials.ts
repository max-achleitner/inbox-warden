import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import keytar from "keytar";

const CONFIG_DIR = path.join(os.homedir(), ".imap-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const KEYCHAIN_SERVICE = "imap-mcp-server";

// Legacy path — used for migration
const LEGACY_CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

export interface Permissions {
  read: boolean;
  write: boolean;
  send: boolean;
  delete: boolean;
}

export const DEFAULT_PERMISSIONS: Permissions = {
  read: true,
  write: true,
  send: false,
  delete: false,
};

export interface Config {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  user: string;
  permissions?: Permissions;
}

export interface Credentials extends Config {
  password: string;
}

/** Load config from ~/.imap-mcp/config.json and password from OS keychain */
export async function loadCredentials(): Promise<Credentials> {
  // Try new config.json first, fall back to legacy credentials.json
  let configPath = CONFIG_FILE;
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_CREDENTIALS_FILE)) {
    configPath = LEGACY_CREDENTIALS_FILE;
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No configuration found. Run "imap-mcp-setup" first to configure your mail account.`
    );
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);

  // Validate required fields
  const required = ["imapHost", "imapPort", "user"] as const;
  for (const field of required) {
    if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") {
      throw new Error(
        `Invalid config: missing "${field}". Run "imap-mcp-setup" to reconfigure.`
      );
    }
  }

  // Validate SMTP fields if send permission is enabled
  const perms = parsed.permissions || DEFAULT_PERMISSIONS;
  if (perms.send) {
    for (const field of ["smtpHost", "smtpPort"] as const) {
      if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") {
        throw new Error(
          `Invalid config: missing "${field}" (required when send permission is enabled). Run "imap-mcp-setup" to reconfigure.`
        );
      }
    }
  }

  // Resolve password: env var > keychain > legacy file > error
  let password = process.env.IMAP_PASSWORD;

  if (!password) {
    password = await keytar.getPassword(KEYCHAIN_SERVICE, parsed.user) ?? undefined;
  }

  // Legacy migration: if password is in the old credentials.json, migrate it
  if (!password && parsed.password) {
    password = parsed.password as string;
    // Migrate to keychain silently
    try {
      await keytar.setPassword(KEYCHAIN_SERVICE, parsed.user, password!);
      // Rewrite config without password
      const { password: _removed, ...configOnly } = parsed;
      fs.writeFileSync(configPath, JSON.stringify(configOnly, null, 2), { mode: 0o600 });
    } catch {
      // Migration failed — still works with inline password this time
    }
  }

  if (!password) {
    throw new Error(
      `No password found. Run "imap-mcp-setup" to store your password securely, or set IMAP_PASSWORD environment variable.`
    );
  }

  const creds: Credentials = {
    imapHost: parsed.imapHost,
    imapPort: parsed.imapPort,
    smtpHost: parsed.smtpHost || "",
    smtpPort: parsed.smtpPort || 465,
    user: parsed.user,
    password,
    permissions: parsed.permissions ? { ...DEFAULT_PERMISSIONS, ...parsed.permissions } : { ...DEFAULT_PERMISSIONS },
  };

  return creds;
}

/** Save config to ~/.imap-mcp/config.json and password to OS keychain */
export async function saveCredentials(creds: Credentials): Promise<void> {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  // Store password in OS keychain
  await keytar.setPassword(KEYCHAIN_SERVICE, creds.user, creds.password);

  // Write config WITHOUT password
  const config: Config & { permissions?: Permissions } = {
    imapHost: creds.imapHost,
    imapPort: creds.imapPort,
    smtpHost: creds.smtpHost,
    smtpPort: creds.smtpPort,
    user: creds.user,
    permissions: creds.permissions,
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });

  // Clean up legacy credentials.json if it exists
  if (fs.existsSync(LEGACY_CREDENTIALS_FILE) && LEGACY_CREDENTIALS_FILE !== CONFIG_FILE) {
    try { fs.unlinkSync(LEGACY_CREDENTIALS_FILE); } catch { /* ignore */ }
  }
}

export function getPermissions(creds: Credentials): Permissions {
  return { ...DEFAULT_PERMISSIONS, ...creds.permissions };
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE) || fs.existsSync(LEGACY_CREDENTIALS_FILE);
}
