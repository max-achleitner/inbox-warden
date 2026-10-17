/**
 * Clean the environment Claude Desktop (MCPB) and Claude Code plugins hand to the server.
 *
 * Both substitute `${user_config.x}` into `env`. A field the user left empty and that has no
 * default stays as the literal placeholder text (the mcpb host only substitutes keys it has a
 * value for), number fields may arrive as "0", booleans as "true"/"false", and free-text fields
 * may have stray spaces or capitals. This runs before host detection and loadConfig(), which then
 * only see clean IMAP_MCP_* values.
 */
import * as path from "node:path";

export class BundleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleConfigError";
  }
}

const PLACEHOLDER = /^\$\{[^}]*\}$/;
/** Values that may legitimately start or end with spaces. */
const SECRET_KEYS = new Set(["IMAP_MCP_PASSWORD", "IMAP_PASSWORD", "IMAP_MCP_OAUTH_CLIENT_SECRET"]);
const PORT_LABELS: Record<string, string> = {
  IMAP_MCP_IMAP_PORT: "IMAP port",
  IMAP_MCP_SMTP_PORT: "SMTP port",
};
const TIERS = ["read", "write", "send", "delete"];
const CHOICES: Record<string, { label: string; values: string[] }> = {
  IMAP_MCP_AUTH: { label: "Sign-in method", values: ["password", "microsoft", "google"] },
  IMAP_MCP_SEND_MODE: { label: "Send mode", values: ["drafts-only", "confirm", "direct"] },
  IMAP_MCP_SENT_COPY: { label: "Sent copy", values: ["auto", "always", "never"] },
  IMAP_MCP_LOCALE: { label: "Language", values: ["de", "en"] },
  IMAP_MCP_LANG: { label: "Language", values: ["de", "en"] },
};

export function applyBundleEnv(env: NodeJS.ProcessEnv): void {
  // A form that has a password field but left it empty (MCPB, plugin) — unlike a hand-written
  // config without the variable, which may rely on the keychain or IMAP_MCP_PASSWORD_FILE.
  const passwordFieldLeftEmpty = "IMAP_MCP_PASSWORD" in env;

  for (const key of Object.keys(env)) {
    if (!key.startsWith("IMAP_MCP_") && key !== "IMAP_PASSWORD") continue;
    const trimmed = (env[key] ?? "").trim();
    if (trimmed === "" || PLACEHOLDER.test(trimmed)) delete env[key];
    else if (!SECRET_KEYS.has(key)) env[key] = trimmed;
  }

  for (const [key, label] of Object.entries(PORT_LABELS)) {
    const value = env[key];
    if (value === undefined) continue;
    if (value === "0") {
      delete env[key];
      continue;
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BundleConfigError(`${label} must be a number between 1 and 65535, or empty for automatic — not "${value}".`);
    }
    env[key] = String(port);
  }

  // MCPB booleans arrive as "true"/"false"; Plan 4 switches the lookups off only for "1".
  if (env.IMAP_MCP_NO_AUTOCONFIG !== undefined) {
    const value = env.IMAP_MCP_NO_AUTOCONFIG.toLowerCase();
    if (value === "true" || value === "1") env.IMAP_MCP_NO_AUTOCONFIG = "1";
    else if (value === "false" || value === "0") delete env.IMAP_MCP_NO_AUTOCONFIG;
    else {
      throw new BundleConfigError(
        `"Do not look up server settings online" must be true or false — not "${env.IMAP_MCP_NO_AUTOCONFIG}".`,
      );
    }
  }

  if (env.IMAP_MCP_ATTACHMENT_DIRS !== undefined) {
    const dirs = cleanDirectories(env.IMAP_MCP_ATTACHMENT_DIRS.split(path.delimiter));
    if (dirs.length > 0) env.IMAP_MCP_ATTACHMENT_DIRS = dirs.join(path.delimiter);
    else delete env.IMAP_MCP_ATTACHMENT_DIRS;
  }

  if (env.IMAP_MCP_PERMISSIONS !== undefined) {
    const requested = env.IMAP_MCP_PERMISSIONS.split(/[\s,;]+/).map((t) => t.toLowerCase()).filter(Boolean);
    const unknown = requested.filter((t) => !TIERS.includes(t));
    if (unknown.length > 0) {
      throw new BundleConfigError(
        `Permissions may only contain ${TIERS.join(", ")} — "${unknown.join(", ")}" is not one of them.`,
      );
    }
    env.IMAP_MCP_PERMISSIONS = TIERS.filter((t) => requested.includes(t)).join(",");
  }

  for (const [key, { label, values }] of Object.entries(CHOICES)) {
    const value = env[key];
    if (value === undefined) continue;
    const lower = value.toLowerCase();
    if (!values.includes(lower)) {
      throw new BundleConfigError(`${label} must be one of ${values.join(", ")} — not "${value}".`);
    }
    env[key] = lower;
  }

  const envOnly = env.IMAP_MCP_EMAIL !== undefined && env.IMAP_MCP_CONFIG === undefined;
  const passwordSignIn = (env.IMAP_MCP_AUTH ?? "password") === "password";
  const hasPassword = ["IMAP_MCP_PASSWORD", "IMAP_MCP_PASSWORD_FILE", "IMAP_PASSWORD"].some((key) => env[key] !== undefined);
  if (envOnly && passwordSignIn && passwordFieldLeftEmpty && !hasPassword) {
    throw new BundleConfigError(
      `Enter the password (or app password) for ${env.IMAP_MCP_EMAIL}, or choose "microsoft" or "google" as sign-in method.`,
    );
  }
}

function cleanDirectories(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "" && !PLACEHOLDER.test(value));
}

/**
 * MCPB substitutes a `multiple` field (here: several attachment folders) only into arguments,
 * never into `env`: `serve --attachment-dirs <dir> <dir> …`, or the unexpanded placeholder when the
 * user picked none. Moves the folders into IMAP_MCP_ATTACHMENT_DIRS (Plan 3) and returns the
 * remaining arguments. An explicitly set IMAP_MCP_ATTACHMENT_DIRS wins.
 */
export function applyBundleArgs(args: string[], env: NodeJS.ProcessEnv): string[] {
  const at = args.indexOf("--attachment-dirs");
  if (at < 0) return args;
  let end = at + 1;
  while (end < args.length && !args[end].startsWith("--")) end++;
  const dirs = cleanDirectories(args.slice(at + 1, end));
  if (dirs.length > 0 && env.IMAP_MCP_ATTACHMENT_DIRS === undefined) {
    env.IMAP_MCP_ATTACHMENT_DIRS = dirs.join(path.delimiter);
  }
  return [...args.slice(0, at), ...args.slice(end)];
}
