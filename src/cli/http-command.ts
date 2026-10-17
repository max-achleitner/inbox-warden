import { loadConfig, saveConfig } from "../config/load.js";
import type { AppConfig } from "../config/schema.js";
import { createRuntimeSecretStore } from "../secrets/container.js";
import { generateBearerToken } from "../transport/auth/bearer.js";
import { mcpResourceUrl } from "../transport/auth/metadata.js";
import { SERVER_NAME } from "../version.js";

export interface HttpCommandDeps {
  loadConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  out(line: string): void;
  err(line: string): void;
  /** IMAP_MCP_EMAIL selects the environment-only configuration, which has no file to store tokens in. */
  envOnly?: boolean;
}

const USAGE = [
  "Usage:",
  `  ${SERVER_NAME} http token create --id <name> [--print-only]`,
  `  ${SERVER_NAME} http token list`,
  `  ${SERVER_NAME} http token revoke --id <name>`,
].join("\n");

const ENV_ONLY_REFUSAL =
  "IMAP_MCP_EMAIL is set, so the server uses the configuration from environment variables, which cannot hold bearer tokens. " +
  "Nothing was saved. Use a configuration file for HTTP mode (IMAP_MCP_CONFIG, see docs/deploy/http.md), or add the entry by hand with --print-only.";

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** `http token …` — the token is shown once; only its SHA-256 is stored in the config. */
export async function runHttpCommand(argv: string[], deps: HttpCommandDeps): Promise<number> {
  const [group, action] = argv;
  if (group !== "token" || !["create", "list", "revoke"].includes(action ?? "")) {
    deps.err(USAGE);
    return 2;
  }

  const config = await deps.loadConfig();
  const auth = config.httpAuth;
  if (auth && auth.mode !== "bearer") {
    deps.err('httpAuth.mode is "oauth" — bearer tokens are not used. Switch the mode to "bearer" first.');
    return 2;
  }
  const tokens = auth?.tokens ?? [];

  if (action === "list") {
    if (tokens.length === 0) deps.out("No bearer tokens configured.");
    for (const t of tokens) deps.out(`${t.id}  sha256:${t.sha256.slice(0, 12)}…`);
    return 0;
  }

  const id = flag(argv, "--id");
  if (!id || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
    deps.err("--id must be 1–32 characters: lowercase letters, digits and dashes.");
    return 2;
  }

  const printOnly = action === "create" && argv.includes("--print-only");
  if (deps.envOnly && !printOnly) {
    deps.err(ENV_ONLY_REFUSAL);
    return 2;
  }

  if (action === "revoke") {
    if (!tokens.some((t) => t.id === id)) {
      deps.err(`No token with id "${id}".`);
      return 1;
    }
    config.httpAuth = { mode: "bearer", tokens: tokens.filter((t) => t.id !== id), principals: auth?.principals ?? [] };
    await deps.saveConfig(config);
    deps.out(`Token "${id}" revoked in the configuration. Restart the server for it to take effect — until then the token still works.`);
    return 0;
  }

  if (tokens.some((t) => t.id === id)) {
    deps.err(`A token with id "${id}" already exists. Revoke it first or choose another id.`);
    return 1;
  }
  const { token, sha256 } = generateBearerToken();
  if (!printOnly) {
    config.httpAuth = { mode: "bearer", tokens: [...tokens, { id, sha256 }], principals: auth?.principals ?? [] };
    await deps.saveConfig(config);
  }
  const endpoint = config.http?.publicUrl ? mcpResourceUrl(config.http.publicUrl) : "http://127.0.0.1:8787/mcp";
  deps.out(`New token "${id}" — shown only once, store it in your MCP client now:`);
  deps.out("");
  deps.out(`  ${token}`);
  deps.out("");
  if (printOnly) {
    deps.out("Add this entry to httpAuth.tokens in the config file:");
    deps.out(`  ${JSON.stringify({ id, sha256 })}`);
    deps.out("");
  }
  deps.out("Claude Code:");
  deps.out(`  claude mcp add --transport http mail ${endpoint} --header "Authorization: Bearer ${token}"`);
  return 0;
}

/** `inbox-warden http …` against the real configuration, with the same secret store as the server. */
export async function runHttpCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const secrets = createRuntimeSecretStore(env);
  return runHttpCommand(argv, {
    loadConfig: () => loadConfig(env, { secrets }),
    saveConfig: (config) => saveConfig(config, env),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    // Same rule as loadConfig(): without IMAP_MCP_CONFIG, IMAP_MCP_EMAIL wins over the config file
    envOnly: !env.IMAP_MCP_CONFIG?.trim() && Boolean(env.IMAP_MCP_EMAIL?.trim()),
  });
}
