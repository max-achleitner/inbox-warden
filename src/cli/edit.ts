import { z } from "zod";
import { ConfigSchema, type AppConfig } from "../config/schema.js";
import type { SecretStore } from "../secrets/store.js";
import { errorMessage } from "../errors.js";
import type { AccountsEditCommand } from "./args.js";
import { t, type Locale } from "./messages.js";

export interface EditDeps {
  locale: Locale;
  print(line: string): void;
  /** The config file (undefined when there is none yet); never the env-only configuration. */
  loadConfig(): Promise<AppConfig | undefined>;
  saveConfig(config: AppConfig): Promise<void>;
  secrets: SecretStore;
  /** Hidden terminal input. */
  readSecret(question: string): Promise<string>;
}

/**
 * `accounts edit <id> …`: change permissions, default account, bulk limits or the password of an
 * existing mailbox without the wizard. Validates the whole configuration before anything is saved.
 */
export async function runAccountsEdit(cmd: AccountsEditCommand, deps: EditDeps): Promise<number> {
  const { locale, print } = deps;
  try {
    const config = await deps.loadConfig();
    if (!config) {
      print(t(locale, "editNoConfig"));
      return 1;
    }
    const account = config.accounts.find((a) => a.id === cmd.accountId);
    if (!account) {
      print(t(locale, "loginUnknownAccount", { id: cmd.accountId, ids: config.accounts.map((a) => a.id).join(", ") }));
      return 1;
    }
    if (cmd.password && account.auth.type !== "password") {
      print(t(locale, "editNotPassword", { id: account.id }));
      return 1;
    }

    const state = (on: boolean) => t(locale, on ? "stateOn" : "stateOff");
    const lines: string[] = [];
    const updated = structuredClone(config);
    const target = updated.accounts.find((a) => a.id === cmd.accountId)!;
    for (const tier of [...cmd.allow, ...cmd.deny]) {
      const value = cmd.allow.includes(tier);
      if (target.permissions[tier] !== value) {
        lines.push(t(locale, "editLine", { name: tier, before: state(target.permissions[tier]), after: state(value) }));
        target.permissions[tier] = value;
      }
    }
    if (cmd.makeDefault) {
      const before = updated.defaultAccount ?? updated.accounts[0].id;
      if (before !== target.id) lines.push(t(locale, "editLine", { name: t(locale, "editDefaultName"), before, after: target.id }));
      updated.defaultAccount = target.id;
    }
    for (const [key, value] of [["maxMessages", cmd.maxMessages], ["maxDelete", cmd.maxDelete]] as const) {
      if (value !== undefined && target.policy.bulk[key] !== value) {
        lines.push(t(locale, "editLine", { name: `bulk.${key}`, before: target.policy.bulk[key], after: value }));
        target.policy.bulk[key] = value;
      }
    }

    const checked = ConfigSchema.safeParse(updated);
    if (!checked.success) {
      print(t(locale, "editInvalid", { message: z.prettifyError(checked.error) }));
      return 1;
    }
    let password: string | undefined;
    if (cmd.password) {
      password = await deps.readSecret(t(locale, "editAskPassword", { email: target.email }));
      if (!password) {
        print(t(locale, "editEmptyPassword"));
        return 1;
      }
      lines.push(t(locale, "editPassword"));
    }
    if (lines.length === 0) {
      print(t(locale, "editUnchanged"));
      return 0;
    }

    await deps.saveConfig(checked.data);
    if (password !== undefined) await deps.secrets.set(target.id, "password", password);
    print(t(locale, "editSaved", { id: target.id }));
    for (const line of lines) print(line);
    print(t(locale, "editRestart"));
    return 0;
  } catch (err) {
    print(t(locale, "editFailed", { message: errorMessage(err) }));
    return 1;
  }
}
