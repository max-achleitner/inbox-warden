/**
 * Clean the environment Claude Desktop (MCPB) and Claude Code plugins hand to the server.
 *
 * Both substitute `${user_config.x}` into `env`. A field the user left empty and that has no
 * default stays as the literal placeholder text (the mcpb host only substitutes keys it has a
 * value for), number fields may arrive as "0", booleans as "true"/"false", and free-text fields
 * may have stray spaces or capitals. This runs before host detection and loadConfig(), which then
 * only see clean IMAP_MCP_* values.
 *
 * It also maps the form onto the variables the server reads: the two switches (send, move to
 * Trash) become IMAP_MCP_PERMISSIONS, "name:port" in a server field is split into host and port,
 * and the other switch becomes IMAP_MCP_NO_AUTOCONFIG.
 */
import { isIPv6 } from "node:net";
import { SERVER_NAME } from "../version.js";
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
const HOST_LABELS: Record<string, { label: string; portKey: string }> = {
  IMAP_MCP_IMAP_HOST: { label: "Advanced: incoming server (IMAP)", portKey: "IMAP_MCP_IMAP_PORT" },
  IMAP_MCP_SMTP_HOST: { label: "Advanced: outgoing server (SMTP)", portKey: "IMAP_MCP_SMTP_PORT" },
};
const SWITCH_LABELS = {
  IMAP_MCP_NO_AUTOCONFIG: "Advanced: don't look up servers online",
  IMAP_MCP_ALLOW_SEND: "Claude may send email",
  IMAP_MCP_ALLOW_DELETE: "Claude may move email to Trash",
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
  // Same for the permission switches: present in the form, but an unexpanded one counts as off.
  const switchesPresent = "IMAP_MCP_ALLOW_SEND" in env || "IMAP_MCP_ALLOW_DELETE" in env;

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

  for (const [key, { label, portKey }] of Object.entries(HOST_LABELS)) {
    const value = env[key];
    if (value === undefined) continue;
    const { host, port } = splitHostPort(value, label);
    env[key] = host;
    if (port === undefined) continue;
    const given = env[portKey];
    if (given !== undefined && given !== port) {
      throw new BundleConfigError(`"${label}" says port ${port}, but the port setting says ${given}. Use one of them.`);
    }
    env[portKey] = port;
  }

  // MCPB booleans arrive as "true"/"false"; Plan 4 switches the lookups off only for "1".
  if (switchOn(env, "IMAP_MCP_NO_AUTOCONFIG")) env.IMAP_MCP_NO_AUTOCONFIG = "1";
  else delete env.IMAP_MCP_NO_AUTOCONFIG;

  // The two permission switches stand in for IMAP_MCP_PERMISSIONS unless that is set (containers).
  const allowSend = switchOn(env, "IMAP_MCP_ALLOW_SEND");
  const allowDelete = switchOn(env, "IMAP_MCP_ALLOW_DELETE");
  delete env.IMAP_MCP_ALLOW_SEND;
  delete env.IMAP_MCP_ALLOW_DELETE;
  if (switchesPresent && env.IMAP_MCP_PERMISSIONS === undefined) {
    env.IMAP_MCP_PERMISSIONS = ["read", "write", ...(allowSend ? ["send"] : []), ...(allowDelete ? ["delete"] : [])].join(",");
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
      `Enter the password (or app password) for ${env.IMAP_MCP_EMAIL} in the settings. Microsoft 365 or Google Workspace sign-in: use the command-line version (${SERVER_NAME} setup).`,
    );
  }
}

/** A switch: true/1 is on, false/0 is off, a missing (or unexpanded) one is off, anything else is refused. */
function switchOn(env: NodeJS.ProcessEnv, key: keyof typeof SWITCH_LABELS): boolean {
  const value = env[key];
  if (value === undefined) return false;
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  throw new BundleConfigError(`"${SWITCH_LABELS[key]}" must be on or off — not "${value}".`);
}

/** "name", "name:port", "[v6]", "[v6]:port" or a bare IPv6 address (more than one colon, no brackets). */
function splitHostPort(value: string, label: string): { host: string; port?: string } {
  const broken = () =>
    new BundleConfigError(`"${label}" must be a server name, optionally with :port (1–65535) — not "${value}".`);
  let host: string;
  let port: string | undefined;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(.*))?$/.exec(value);
    if (!match) throw broken();
    host = match[1];
    port = match[2];
    if (!isIPv6(host)) throw broken();
  } else if (value.split(":").length === 2) {
    [host, port] = value.split(":");
  } else {
    host = value;
    if (value.includes(":") && !isIPv6(value)) throw broken();
  }
  if (host === "") throw broken();
  if (port === undefined) return { host };
  const number = /^\d+$/.test(port) ? Number(port) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw broken();
  return { host, port: String(number) };
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
