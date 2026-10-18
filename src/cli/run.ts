import * as fs from "node:fs";
import * as path from "node:path";
import { configDir, configFilePath, loadConfig, saveConfig } from "../config/load.js";
import type { AppConfig } from "../config/schema.js";
import type { SecretStore } from "../secrets/store.js";
import { createRuntimeSecretStore } from "../secrets/container.js";
import { createAuthProvider } from "../auth/provider.js";
import { runDeviceCodeAuthorization, runLoopbackAuthorization } from "../auth/oauth/flow.js";
import { detectProvider, withDetectedEndpoints } from "../onboarding/autoconfig.js";
import { probeCertificate } from "../onboarding/cert-probe.js";
import { testAccountConnection } from "../onboarding/connection-test.js";
import { errorMessage } from "../errors.js";
import { auditDir } from "../audit/setup.js";
import { parseCliArgs, type AccountsEditCommand, type AccountsLoginCommand } from "./args.js";
import { runAuditVerify } from "./audit.js";
import { formatAccountList, runDoctor } from "./doctor.js";
import { runAccountsLogin } from "./login.js";
import { detectLocale, t, type Locale } from "./messages.js";
import { runAccountsEdit } from "./edit.js";
import { createTerminalPrompter, type Prompter } from "./prompt.js";
import { runSetup } from "./setup.js";

/** What every CLI command needs. Tests replace parts; Plan 7 replaces `createSecrets` for containers. */
export interface CliDeps {
  env: NodeJS.ProcessEnv;
  locale: Locale;
  print(line: string): void;
  createSecrets(env: NodeJS.ProcessEnv): SecretStore;
}

export function defaultCliDeps(env: NodeJS.ProcessEnv = process.env): CliDeps {
  return {
    env,
    locale: detectLocale(env),
    print: (line) => process.stdout.write(`${line}\n`),
    createSecrets: (e) => createRuntimeSecretStore(e),
  };
}

const autoconfigEnabled = (env: NodeJS.ProcessEnv) => env.IMAP_MCP_NO_AUTOCONFIG !== "1";

/** The config file the wizard edits — never the env-only configuration. */
async function loadFileConfig(env: NodeJS.ProcessEnv, secrets: SecretStore): Promise<AppConfig | undefined> {
  if (!fs.existsSync(configFilePath(env))) return undefined;
  return loadConfig({ ...env, IMAP_MCP_EMAIL: "" }, { secrets });
}

/** The configuration the server would use (env-only or file), hosts autodetected like the server does. */
async function loadEffectiveConfig(env: NodeJS.ProcessEnv, secrets: SecretStore): Promise<AppConfig> {
  return loadConfig(autoconfigEnabled(env) ? await withDetectedEndpoints(env) : env, { secrets });
}

export async function setupCommand(deps: CliDeps): Promise<number> {
  const prompter = createTerminalPrompter(deps.locale);
  const secrets = deps.createSecrets(deps.env);
  return runSetup({
    prompter,
    locale: deps.locale,
    envMode: Boolean(deps.env.IMAP_MCP_EMAIL),
    loadExisting: () => loadFileConfig(deps.env, secrets),
    save: async (config, staged, removed) => {
      for (const s of staged) await secrets.set(s.accountId, s.key, s.value);
      for (const id of removed) {
        await secrets.delete(id, "password").catch(() => {});
        await secrets.delete(id, "oauthRefreshToken").catch(() => {});
      }
      await saveConfig(config, deps.env);
    },
    detect: (email) => detectProvider(email, { network: autoconfigEnabled(deps.env) }),
    test: (account, provider, presetId) => testAccountConnection(account, provider, { presetId }),
    probe: probeCertificate,
    authorize: (profile, mode, loginHint) => {
      const opts = { print: (line: string) => prompter.print(line), language: deps.locale, loginHint };
      return mode === "browser" ? runLoopbackAuthorization(profile, opts) : runDeviceCodeAuthorization(profile, opts);
    },
  });
}

export async function doctorCommand(deps: CliDeps): Promise<number> {
  const secrets = deps.createSecrets(deps.env);
  return runDoctor({
    locale: deps.locale,
    print: deps.print,
    secrets,
    loadConfig: () => loadEffectiveConfig(deps.env, secrets),
    createProvider: (account, store) => createAuthProvider(account, store),
    test: (account, provider) => testAccountConnection(account, provider),
  });
}

export async function accountsListCommand(deps: CliDeps): Promise<number> {
  const secrets = deps.createSecrets(deps.env);
  try {
    const configured = fs.existsSync(configFilePath(deps.env)) || Boolean(deps.env.IMAP_MCP_EMAIL?.trim());
    const config = configured ? await loadConfig(deps.env, { secrets }) : undefined;
    for (const line of formatAccountList(deps.locale, config)) deps.print(line);
    return 0;
  } catch (err) {
    deps.print(t(deps.locale, "configFailed", { message: errorMessage(err) }));
    return 1;
  }
}

export async function accountsEditCommand(cmd: AccountsEditCommand, deps: CliDeps): Promise<number> {
  const secrets = deps.createSecrets(deps.env);
  if (deps.env.IMAP_MCP_EMAIL) deps.print(t(deps.locale, "envMode"));
  let prompter: Prompter | undefined;
  try {
    return await runAccountsEdit(cmd, {
      locale: deps.locale,
      print: deps.print,
      secrets,
      loadConfig: () => loadFileConfig(deps.env, secrets),
      saveConfig: (config) => saveConfig(config, deps.env),
      readSecret: (question) => (prompter ??= createTerminalPrompter(deps.locale)).secret(question),
    });
  } finally {
    prompter?.close();
  }
}

export async function accountsLoginCommand(cmd: AccountsLoginCommand, deps: CliDeps): Promise<number> {
  const secrets = deps.createSecrets(deps.env);
  return runAccountsLogin(cmd, {
    locale: deps.locale,
    print: deps.print,
    secrets,
    loadConfig: () => loadEffectiveConfig(deps.env, secrets),
  });
}

/** `audit verify [<folder|file>]`: 0 intact (or no records yet), 1 tampered or incomplete, 2 unreadable path. */
export async function auditVerifyCommand(deps: CliDeps, target?: string): Promise<number> {
  if (target) return runAuditVerify(path.resolve(target), deps.locale, deps.print);
  const config = await loadConfig(deps.env).catch(() => undefined);
  const dir = config ? auditDir(config, deps.env) : path.join(configDir(deps.env), "audit");
  if (!fs.existsSync(dir)) {
    deps.print(t(deps.locale, "auditEmpty", { path: dir }));
    return 0;
  }
  return runAuditVerify(dir, deps.locale, deps.print);
}

/**
 * `inbox-warden [setup | doctor | accounts list | accounts login <id> … | accounts edit <id> … | audit verify [<folder|file>]]`. Returns the exit code.
 * New commands: extend CliCommand + parseCliArgs (args.ts), add a `case` here and a `<name>Command(deps)` function.
 */
export async function runCli(argv: string[], deps: CliDeps = defaultCliDeps()): Promise<number> {
  const cmd = parseCliArgs(argv);
  switch (cmd.command) {
    case "setup":
      return setupCommand(deps);
    case "doctor":
      return doctorCommand(deps);
    case "accounts-list":
      return accountsListCommand(deps);
    case "accounts-login":
      return accountsLoginCommand(cmd, deps);
    case "accounts-edit":
      return accountsEditCommand(cmd, deps);
    case "audit-verify":
      return auditVerifyCommand(deps, cmd.path);
    case "help":
      deps.print(t(deps.locale, "usage"));
      return 0;
    case "invalid":
      deps.print(cmd.message[deps.locale]);
      deps.print(t(deps.locale, "usage"));
      return 2;
  }
}
