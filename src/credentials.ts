import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".imap-mcp");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

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

export interface Credentials {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  user: string;
  password: string;
  permissions?: Permissions;
}

/** Load credentials from ~/.imap-mcp/credentials.json */
export function loadCredentials(): Credentials {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    throw new Error(
      `No credentials found. Run "npm run setup" first to configure your mail account.`
    );
  }

  const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
  const parsed = JSON.parse(raw);

  // Validate required fields
  const required = ["imapHost", "imapPort", "user", "password"] as const;
  for (const field of required) {
    if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") {
      throw new Error(
        `Invalid credentials: missing "${field}". Run "npm run setup" to reconfigure.`
      );
    }
  }

  // Validate SMTP fields if send permission is enabled
  const perms = parsed.permissions || DEFAULT_PERMISSIONS;
  if (perms.send) {
    for (const field of ["smtpHost", "smtpPort"] as const) {
      if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") {
        throw new Error(
          `Invalid credentials: missing "${field}" (required when send permission is enabled). Run "npm run setup" to reconfigure.`
        );
      }
    }
  }

  const creds = parsed as Credentials;
  // Backfill defaults for configs saved before permissions existed
  if (!creds.permissions) {
    creds.permissions = { ...DEFAULT_PERMISSIONS };
  }
  return creds;
}

/** Save credentials to ~/.imap-mcp/credentials.json with restricted permissions */
export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
}

export function getPermissions(creds: Credentials): Permissions {
  return { ...DEFAULT_PERMISSIONS, ...creds.permissions };
}

export function credentialsExist(): boolean {
  return fs.existsSync(CREDENTIALS_FILE);
}
