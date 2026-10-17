import type { LocalizedText } from "../onboarding/presets.js";

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

export type CliCommand =
  | { command: "setup" }
  | { command: "doctor" }
  | { command: "accounts-list" }
  | AccountsLoginCommand
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
    return invalid("„accounts“ erwartet „list“ oder „login <id>“.", '"accounts" expects "list" or "login <id>".');
  }
  if (first === "audit") {
    if (second === "verify" && rest.length <= 1) {
      return { command: "audit-verify", ...(rest[0] !== undefined ? { path: rest[0] } : {}) };
    }
    return invalid("„audit“ erwartet „verify [<Ordner|Datei>]“.", '"audit" expects "verify [<folder|file>]".');
  }
  return invalid(`Unbekannter Befehl: ${first}`, `Unknown command: ${first}`);
}
