import type { AppConfig } from "../config/schema.js";
import type { SecretStore } from "../secrets/store.js";
import { profileFor, type OAuthProfile } from "../auth/oauth/profiles.js";
import {
  runDeviceCodeAuthorization,
  runLoopbackAuthorization,
  type AuthorizedTokens,
  type InteractiveAuthOptions,
} from "../auth/oauth/flow.js";
import { errorMessage } from "../errors.js";
import type { AccountsLoginCommand } from "./args.js";
import { t, type Locale } from "./messages.js";

export interface LoginDeps {
  locale: Locale;
  print(line: string): void;
  loadConfig(): Promise<AppConfig>;
  /** Whatever createSecretStore returns (Plan 7: the container runtime store). */
  secrets: SecretStore;
  loopback?(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens>;
  deviceCode?(profile: OAuthProfile, opts: InteractiveAuthOptions): Promise<AuthorizedTokens>;
}

/** `accounts login <id>`: sign an OAuth mailbox in (again) without the wizard — also inside containers. */
export async function runAccountsLogin(cmd: AccountsLoginCommand, deps: LoginDeps): Promise<number> {
  const { locale, print } = deps;
  try {
    const config = await deps.loadConfig();
    const account = config.accounts.find((a) => a.id === cmd.accountId);
    if (!account) {
      print(t(locale, "loginUnknownAccount", { id: cmd.accountId, ids: config.accounts.map((a) => a.id).join(", ") }));
      return 1;
    }
    if (account.auth.type !== "oauth2") {
      print(t(locale, "loginNotOAuth", { id: account.id }));
      return 1;
    }
    const profile = profileFor(account);
    if (cmd.mode === "device-code" && !profile.deviceCodeUrl) {
      print(t(locale, "loginNoDeviceCode", { provider: profile.provider === "google" ? "Google" : "Microsoft" }));
      return 1;
    }
    const opts: InteractiveAuthOptions = {
      print,
      language: locale,
      loginHint: account.email,
      ...(cmd.mode === "no-browser" ? { openBrowser: false as const } : {}),
      ...(cmd.listenHost !== undefined ? { listenHost: cmd.listenHost } : {}),
      ...(cmd.port !== undefined ? { port: cmd.port } : {}),
    };
    const tokens =
      cmd.mode === "device-code"
        ? await (deps.deviceCode ?? runDeviceCodeAuthorization)(profile, opts)
        : await (deps.loopback ?? runLoopbackAuthorization)(profile, opts);
    await deps.secrets.set(account.id, "oauthRefreshToken", tokens.refreshToken);
    print(t(locale, "loginSuccess", { email: account.email }));
    return 0;
  } catch (err) {
    print(t(locale, "loginFailed", { message: errorMessage(err) }));
    return 1;
  }
}
