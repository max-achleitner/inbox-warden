import type { LocalizedText } from "../onboarding/presets.js";
import type { PermissionTier } from "../config/schema.js";

export type LoginMode = "browser" | "no-browser" | "device-code";

export interface AccountsLoginCommand {
  command: "accounts-login";
  accountId: string;
  mode: LoginMode;
  /** Only with --no-browser: interface the redirect receiver listens on (container: 0.0.0.0). */
  listenHost?: string;
  /** Only with --no-browser: fixed receiver port (container: the published port). */
  port?: number;
}

/** `accounts edit <id> …`: change an existing mailbox without the wizard. */
export interface AccountsEditCommand {
  command: "accounts-edit";
  accountId: string;
  allow: PermissionTier[];
  deny: PermissionTier[];
  makeDefault: boolean;
  /** policy.bulk.maxMessages */
  maxMessages?: number;
  /** policy.bulk.maxDelete */
  maxDelete?: number;
  /** Folder patterns to add to policy.folders.deny (--lock-folder, repeatable). */
  lockFolders: string[];
  /** Exact policy.folders.deny entries to remove (--unlock-folder, repeatable). */
  unlockFolders: string[];
  /** Ask for a new password (hidden) and store it in the secret store. */
  password: boolean;
}

export type CliCommand =
  | { command: "setup" }
  | { command: "doctor" }
  | { command: "accounts-list" }
  | AccountsLoginCommand
  | AccountsEditCommand
  | { command: "audit-verify"; path?: string }
  | { command: "help" }
  | { command: "invalid"; message: LocalizedText };

function invalid(de: string, en: string): CliCommand {
  return { command: "invalid", message: { de, en } };
}

function parseLogin(args: string[]): CliCommand {
  const [accountId, ...flags] = args;
  if (!accountId || accountId.startsWith("-")) {
    return invalid(
      "„accounts login“ braucht die Kennung des Postfachs, z. B.: accounts login main",
      '"accounts login" needs the mailbox id, e.g.: accounts login main',
    );
  }
  let mode: LoginMode = "browser";
  let listenHost: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--device-code" || flag === "--no-browser") {
      const next: LoginMode = flag === "--device-code" ? "device-code" : "no-browser";
      if (mode !== "browser" && mode !== next) {
        return invalid("--device-code und --no-browser schließen einander aus.", "--device-code and --no-browser cannot be combined.");
      }
      mode = next;
    } else if (flag === "--listen-host" || flag === "--port") {
      const value = flags[++i];
      if (value === undefined || value.startsWith("--")) return invalid(`${flag} braucht einen Wert.`, `${flag} needs a value.`);
      if (flag === "--port") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return invalid(`--port muss eine Zahl zwischen 1 und 65535 sein (nicht „${value}“).`, `--port must be a number between 1 and 65535 (not "${value}").`);
        }
        port = n;
      } else {
        listenHost = value;
      }
    } else {
      return invalid(`Unbekannte Option: ${flag}`, `Unknown option: ${flag}`);
    }
  }
  if ((listenHost !== undefined || port !== undefined) && mode !== "no-browser") {
    return invalid("--listen-host und --port gehen nur zusammen mit --no-browser.", "--listen-host and --port only work together with --no-browser.");
  }
  return {
    command: "accounts-login",
    accountId,
    mode,
    ...(listenHost !== undefined ? { listenHost } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

const TIERS: readonly PermissionTier[] = ["read", "write", "send", "delete"];

function parseEdit(args: string[]): CliCommand {
  const [accountId, ...flags] = args;
  if (!accountId || accountId.startsWith("-")) {
    return invalid(
      "„accounts edit“ braucht die Kennung des Postfachs, z. B.: accounts edit main --allow send",
      '"accounts edit" needs the mailbox id, e.g.: accounts edit main --allow send',
    );
  }
  const cmd: AccountsEditCommand = {
    command: "accounts-edit",
    accountId,
    allow: [],
    deny: [],
    makeDefault: false,
    lockFolders: [],
    unlockFolders: [],
    password: false,
  };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--default") {
      cmd.makeDefault = true;
    } else if (flag === "--password") {
      cmd.password = true;
    } else if (flag === "--lock-folder" || flag === "--unlock-folder") {
      const value = flags[++i]?.trim();
      if (!value || value.startsWith("--")) {
        return invalid(`${flag} braucht einen Ordnernamen, z. B. ${flag} _NDA_Inbox`, `${flag} needs a folder name, e.g. ${flag} _NDA_Inbox`);
      }
      const list = flag === "--lock-folder" ? cmd.lockFolders : cmd.unlockFolders;
      if (!list.includes(value)) list.push(value);
    } else if (flag === "--allow" || flag === "--deny" || flag === "--max-messages" || flag === "--max-delete") {
      const value = flags[++i];
      if (value === undefined || value.startsWith("--")) return invalid(`${flag} braucht einen Wert.`, `${flag} needs a value.`);
      if (flag === "--allow" || flag === "--deny") {
        if (!TIERS.includes(value as PermissionTier)) {
          return invalid(`${flag} erwartet read, write, send oder delete (nicht „${value}“).`, `${flag} expects read, write, send or delete (not "${value}").`);
        }
        (flag === "--allow" ? cmd.allow : cmd.deny).push(value as PermissionTier);
      } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return invalid(`${flag} muss eine positive ganze Zahl sein (nicht „${value}“).`, `${flag} must be a positive whole number (not "${value}").`);
        }
        if (flag === "--max-messages") cmd.maxMessages = n;
        else cmd.maxDelete = n;
      }
    } else {
      return invalid(`Unbekannte Option: ${flag}`, `Unknown option: ${flag}`);
    }
  }
  const both = cmd.allow.find((tier) => cmd.deny.includes(tier));
  if (both) return invalid(`„${both}“ ist zugleich erlaubt und verboten.`, `"${both}" is both allowed and denied.`);
  const lockedAndUnlocked = cmd.lockFolders.find((folder) => cmd.unlockFolders.includes(folder));
  if (lockedAndUnlocked) {
    return invalid(
      `„${lockedAndUnlocked}“ soll zugleich gesperrt und freigegeben werden.`,
      `"${lockedAndUnlocked}" is both locked and unlocked.`,
    );
  }
  const changes =
    cmd.allow.length + cmd.deny.length + cmd.lockFolders.length + cmd.unlockFolders.length + (cmd.makeDefault ? 1 : 0) + (cmd.password ? 1 : 0);
  if (changes === 0 && cmd.maxMessages === undefined && cmd.maxDelete === undefined) {
    return invalid(
      "„accounts edit“ braucht mindestens eine Option: --allow/--deny <read|write|send|delete>, --default, --max-messages <n>, --max-delete <n>, --lock-folder/--unlock-folder <ordner>, --password",
      '"accounts edit" needs at least one option: --allow/--deny <read|write|send|delete>, --default, --max-messages <n>, --max-delete <n>, --lock-folder/--unlock-folder <folder>, --password',
    );
  }
  return cmd;
}

/** Pure argument parsing for the `inbox-warden` admin commands; no argument means `setup`. */
export function parseCliArgs(argv: string[]): CliCommand {
  const [first, second, ...rest] = argv;
  if (first === undefined) return { command: "setup" };
  if (first === "help" || first === "--help" || first === "-h") return { command: "help" };
  if (first === "setup" || first === "doctor") {
    return argv.length === 1 ? { command: first } : invalid(`Unbekannte Option für ${first}: ${second}`, `Unknown option for ${first}: ${second}`);
  }
  if (first === "accounts") {
    if (second === "list" && rest.length === 0) return { command: "accounts-list" };
    if (second === "login") return parseLogin(rest);
    if (second === "edit") return parseEdit(rest);
    return invalid("„accounts“ erwartet „list“, „login <id>“ oder „edit <id>“.", '"accounts" expects "list", "login <id>" or "edit <id>".');
  }
  if (first === "audit") {
    if (second === "verify" && rest.length <= 1) {
      return { command: "audit-verify", ...(rest[0] !== undefined ? { path: rest[0] } : {}) };
    }
    return invalid("„audit“ erwartet „verify [<Ordner|Datei>]“.", '"audit" expects "verify [<folder|file>]".');
  }
  return invalid(`Unbekannter Befehl: ${first}`, `Unknown command: ${first}`);
}
