import { DOCS_URL, SERVER_NAME } from "../version.js";

/** Top-level commands. Extend `Command`, `SUBCOMMANDS` and `helpText()` together. */
export type Command = "serve" | "setup" | "doctor" | "accounts" | "audit" | "http" | "help" | "version";

export interface ParsedCommand {
  command: Command;
  args: string[];
}

/** Commands that take their own arguments. */
export const SUBCOMMANDS: ReadonlySet<Command> = new Set<Command>(["serve", "setup", "doctor", "accounts", "audit", "http"]);

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h", "help"]);
const VERSION_FLAGS: ReadonlySet<string> = new Set(["--version", "-v", "version"]);

export class UnknownCommandError extends Error {
  constructor(readonly input: string) {
    super(`Unknown command "${input}". Run "${SERVER_NAME} help" to see the available commands.`);
    this.name = "UnknownCommandError";
  }
}

/** No arguments means "serve": that is how Claude Desktop and Claude Code start the server. */
export function parseCommand(argv: string[]): ParsedCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { command: "serve", args: [] };
  if (VERSION_FLAGS.has(first)) return { command: "version", args: [] };
  if (HELP_FLAGS.has(first)) return { command: "help", args: [] };
  if (first.startsWith("-")) return { command: "serve", args: argv };
  if (SUBCOMMANDS.has(first as Command)) return { command: first as Command, args: rest };
  throw new UnknownCommandError(first);
}

export function helpText(): string {
  return [
    `Usage: ${SERVER_NAME} [command]`,
    "",
    "Commands:",
    "  serve          Start the MCP server on stdio (default; used by Claude Desktop and Claude Code)",
    "  setup          Add or change mail accounts, sign-in, permissions and policy",
    "  doctor         Check configuration, connections, certificates and permissions",
    "  accounts       accounts list: show the mail accounts · accounts login <id>: sign in again",
    "  audit verify   Check that the audit log has not been altered",
    "  serve --http   Run as a remote MCP server over HTTPS (needs httpAuth; see docs/deploy/http.md)",
    "  http token     create | list | revoke bearer tokens for serve --http (only hashes are stored)",
    "  help           Show this help",
    "  version        Print the version",
    "",
    `Documentation: ${DOCS_URL}`,
    "",
  ].join("\n");
}

/**
 * Pre-1.0 start commands keep working until 2.0.0. The old setup command keeps its documented
 * forms (`… doctor`, `… accounts list`, `… help`); anything else starts the setup wizard.
 */
export function legacyInvocation(target: "serve" | "setup", argv: string[]): { parsed: ParsedCommand; warning: string } {
  const [first] = argv;
  const forwards =
    target === "setup" &&
    first !== undefined &&
    first !== "serve" &&
    (SUBCOMMANDS.has(first as Command) || HELP_FLAGS.has(first) || VERSION_FLAGS.has(first));
  const parsed: ParsedCommand = forwards ? parseCommand(argv) : { command: target, args: argv };
  return {
    parsed,
    warning:
      `${SERVER_NAME}: this start command is deprecated and will stop working in ${SERVER_NAME} 2.0. ` +
      `Use "${SERVER_NAME} ${parsed.command}" instead.\n`,
  };
}
