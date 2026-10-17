import type { AccountConfig, AppConfig } from "../config/schema.js";
import type { AuthProvider } from "../auth/provider.js";
import type { SecretStore } from "../secrets/store.js";
import { isLoopback, pinFromEndpoint } from "../connection-security.js";
import type { AccountTestReport } from "../onboarding/connection-test.js";
import { diagnose } from "../onboarding/diagnose.js";
import { errorMessage } from "../errors.js";
import { t, type Locale } from "./messages.js";

export interface DoctorDeps {
  locale: Locale;
  print(line: string): void;
  /** Created before the config is loaded (Plan 2: loadConfig(env, { secrets })). */
  secrets: SecretStore;
  loadConfig(): Promise<AppConfig>;
  createProvider(account: AccountConfig, secrets: SecretStore): AuthProvider;
  test(account: AccountConfig, provider: AuthProvider): Promise<AccountTestReport>;
}

export function describeTls(locale: Locale, protocol: "IMAP" | "SMTP", endpoint: AccountConfig["imap"]): string {
  const pin = pinFromEndpoint(endpoint);
  if (pin) return t(locale, "tlsPinned", { protocol, fingerprint: `${pin.fingerprint256.slice(0, 23)}…` });
  const implicitPort = protocol === "IMAP" ? 993 : 465;
  if (endpoint.port === implicitPort) return t(locale, "tlsImplicit", { protocol, port: endpoint.port });
  if (isLoopback(endpoint.host)) return t(locale, "tlsLoopback", { protocol, host: endpoint.host, port: endpoint.port });
  return t(locale, "tlsStartTls", { protocol, port: endpoint.port });
}

/** Non-interactive health report. Exit code 0 = everything works, 1 = at least one problem. */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const { locale, print } = deps;
  print(t(locale, "doctorTitle"));
  let config: AppConfig;
  try {
    config = await deps.loadConfig();
  } catch (err) {
    print(t(locale, "configFailed", { message: errorMessage(err) }));
    print(t(locale, "runSetup"));
    return 1;
  }
  print(t(locale, "configOk", { count: config.accounts.length }));
  const secrets = deps.secrets;

  let problems = 0;
  for (const account of config.accounts) {
    print("");
    print(`${account.id} <${account.email}>`);
    const key = account.auth.type === "password" ? "password" : "oauthRefreshToken";
    try {
      if (!(await secrets.get(account.id, key))) {
        print(t(locale, "secretMissing"));
        problems++;
        continue;
      }
      print(t(locale, "secretOk"));
    } catch (err) {
      print(t(locale, "secretFailed", { message: diagnose(err, { protocol: "imap", host: account.imap.host, port: account.imap.port }).message[locale] }));
      problems++;
      continue;
    }

    print(describeTls(locale, "IMAP", account.imap));
    if (account.smtp) print(describeTls(locale, "SMTP", account.smtp));

    const report = await deps.test(account, deps.createProvider(account, secrets));
    if (report.imap.ok) {
      print(t(locale, "imapOk", { folders: report.imap.folderCount, keywords: t(locale, report.imap.capabilities.customKeywords ? "yes" : "no") }));
    } else {
      print(t(locale, "stepFailed", { step: t(locale, "stepImap"), message: report.imap.diagnosis.message[locale] }));
      problems++;
    }
    if (!report.smtp) {
      print(t(locale, "smtpMissing"));
    } else if (report.smtp.ok) {
      print(t(locale, "smtpOk"));
    } else {
      print(t(locale, "stepFailed", { step: t(locale, "stepSmtp"), message: report.smtp.diagnosis.message[locale] }));
      problems++;
    }

    const tiers = (["read", "write", "send", "delete"] as const).map((tier) => `${tier} ${account.permissions[tier] ? "✓" : "✗"}`);
    print(t(locale, "permissionsLine", { list: tiers.join(", ") }));
  }

  print("");
  print(problems === 0 ? t(locale, "doctorOk") : t(locale, "doctorProblems", { count: problems }));
  return problems === 0 ? 0 : 1;
}

export function formatAccountList(locale: Locale, config: AppConfig | undefined): string[] {
  if (!config || config.accounts.length === 0) return [t(locale, "accountsEmpty")];
  return config.accounts.map((a) => {
    const auth = a.auth.type === "oauth2" ? `oauth2:${a.auth.provider}` : "password";
    const tiers = (["read", "write", "send", "delete"] as const).filter((tier) => a.permissions[tier]).join("+");
    const marker = config.defaultAccount === a.id ? "*" : " ";
    return `${marker} ${a.id.padEnd(16)} ${a.email.padEnd(32)} ${a.imap.host.padEnd(28)} ${auth.padEnd(16)} ${tiers}`;
  });
}
