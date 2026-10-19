import { AccountSchema, ConfigSchema, type AccountConfig, type AppConfig } from "../config/schema.js";
import type { AuthProvider } from "../auth/provider.js";
import { OAuthAuthProvider } from "../auth/oauth/provider.js";
import { MICROSOFT_DEFAULT_CLIENT_ID, googleProfile, microsoftProfile, type OAuthProfile } from "../auth/oauth/profiles.js";
import { MemorySecretStore, type StoredSecret } from "../secrets/memory-store.js";
import type { DetectedProvider } from "../onboarding/autoconfig.js";
import type { CertificateInfo, ProbeOptions } from "../onboarding/cert-probe.js";
import type { AccountTestReport } from "../onboarding/connection-test.js";
import type { Diagnosis } from "../onboarding/diagnose.js";
import { t, type Locale } from "./messages.js";
import { PromptCancelledError, type Prompter } from "./prompt.js";

export interface SetupDeps {
  prompter: Prompter;
  locale: Locale;
  /** The current config file, or undefined when none exists yet. */
  loadExisting(): Promise<AppConfig | undefined>;
  /** Write secrets first, then the config; delete the secrets of removed accounts. */
  save(config: AppConfig, secrets: StoredSecret[], removedAccountIds: string[]): Promise<void>;
  detect(email: string): Promise<DetectedProvider>;
  test(account: AccountConfig, provider: AuthProvider, presetId?: string): Promise<AccountTestReport>;
  probe(opts: ProbeOptions): Promise<CertificateInfo>;
  authorize(profile: OAuthProfile, mode: "browser" | "code", loginHint: string): Promise<{ refreshToken: string }>;
  /** Server is configured through IMAP_MCP_* environment variables (MCPB bundle). */
  envMode?: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function suggestAccountId(email: string, taken: Set<string>): string {
  if (!taken.has("main")) return "main";
  const base =
    (email.split("@")[1] ?? "mail").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "mail";
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

function portProblem(locale: Locale) {
  return (value: string) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : t(locale, "invalidPort");
  };
}

function staticPasswordProvider(user: string, password: string): AuthProvider {
  return {
    imapAuth: async () => ({ user, pass: password }),
    smtpAuth: async () => ({ user, pass: password }),
    invalidate: async () => {},
  };
}

interface Failure {
  step: "imap" | "smtp";
  diagnosis: Diagnosis;
}

function failures(report: AccountTestReport): Failure[] {
  const out: Failure[] = [];
  if (!report.imap.ok) out.push({ step: "imap", diagnosis: report.imap.diagnosis });
  if (report.smtp && !report.smtp.ok) out.push({ step: "smtp", diagnosis: report.smtp.diagnosis });
  return out;
}

async function askPassword(deps: SetupDeps, account: AccountConfig, staged: MemorySecretStore, appPassword: boolean): Promise<AuthProvider> {
  let password = "";
  while (!password) password = await deps.prompter.secret(t(deps.locale, appPassword ? "askAppPassword" : "askPassword"));
  await staged.set(account.id, "password", password);
  const user = (account.auth.type === "password" ? account.auth.username : undefined) ?? account.email;
  return staticPasswordProvider(user, password);
}

async function askOAuthSettings(deps: SetupDeps, provider: "microsoft" | "google", detected: DetectedProvider) {
  const { prompter: p, locale } = deps;
  if (provider === "google") {
    const clientId = await p.text(t(locale, "askGoogleClientId"), {
      validate: (v) => (v.endsWith(".apps.googleusercontent.com") ? undefined : "… .apps.googleusercontent.com"),
    });
    let clientSecret = "";
    while (!clientSecret) clientSecret = await p.secret(t(locale, "askGoogleSecret"));
    return { clientId, clientSecret };
  }
  const clientId = MICROSOFT_DEFAULT_CLIENT_ID
    ? undefined
    : await p.text(t(locale, "askClientId"), { validate: (v) => (GUID.test(v) ? undefined : "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx") });
  const tenant = detected.tenant === "consumers" ? "consumers" : (await p.text(t(locale, "askTenant"), { default: "" })) || undefined;
  return { ...(clientId ? { clientId } : {}), ...(tenant ? { tenant } : {}) };
}

function profileOf(account: AccountConfig): OAuthProfile {
  if (account.auth.type !== "oauth2") throw new Error("not an OAuth account");
  return account.auth.provider === "microsoft" ? microsoftProfile(account.auth) : googleProfile(account.auth);
}

async function signIn(deps: SetupDeps, account: AccountConfig, staged: MemorySecretStore): Promise<void> {
  const { prompter: p, locale } = deps;
  const profile = profileOf(account);
  const mode =
    profile.provider === "microsoft"
      ? await p.select(
          t(locale, "askSignInMode"),
          [
            { value: "browser" as const, label: t(locale, "signInBrowser") },
            { value: "code" as const, label: t(locale, "signInCode") },
          ],
          "browser",
        )
      : "browser";
  const { refreshToken } = await deps.authorize(profile, mode, account.email);
  await staged.set(account.id, "oauthRefreshToken", refreshToken);
  p.print(t(locale, "signedIn"));
}

async function addAccount(deps: SetupDeps, existing: AppConfig | undefined): Promise<AppConfig | undefined> {
  const { prompter: p, locale } = deps;
  const taken = new Set(existing?.accounts.map((a) => a.id) ?? []);
  const email = (await p.text(t(locale, "askEmail"), { validate: (v) => (EMAIL.test(v) ? undefined : t(locale, "invalidEmail")) })).trim();

  p.print(t(locale, "detecting"));
  const detected = await deps.detect(email);
  p.print(t(locale, "detected", { name: detected.name }));
  p.print(t(locale, "serverLine", { protocol: "IMAP", host: detected.imap.host, port: detected.imap.port }));
  p.print(t(locale, "serverLine", { protocol: "SMTP", host: detected.smtp.host, port: detected.smtp.port }));
  for (const note of detected.notes) p.print(`  ${note[locale]}`);
  if (detected.helpUrl) p.print(t(locale, "helpLink", { url: detected.helpUrl }));

  let imap = { host: detected.imap.host, port: detected.imap.port };
  let smtp = { host: detected.smtp.host, port: detected.smtp.port };
  if (!(await p.confirm(t(locale, "useDetected"), detected.source !== "guess"))) {
    imap = {
      host: await p.text(t(locale, "askImapHost"), { default: imap.host }),
      port: Number(await p.text(t(locale, "askImapPort"), { default: String(imap.port), validate: portProblem(locale) })),
    };
    smtp = {
      host: await p.text(t(locale, "askSmtpHost"), { default: smtp.host }),
      port: Number(await p.text(t(locale, "askSmtpPort"), { default: String(smtp.port), validate: portProblem(locale) })),
    };
  }

  const oauthProvider = detected.auth === "oauth2-microsoft" ? "microsoft" : detected.auth === "oauth2-google" ? "google" : undefined;
  const method = oauthProvider
    ? await p.select(
        t(locale, "askAuthMethod"),
        [
          { value: "oauth" as const, label: t(locale, "authOAuth", { provider: oauthProvider === "microsoft" ? "Microsoft" : "Google" }) },
          { value: "password" as const, label: t(locale, "authPassword") },
        ],
        "oauth",
      )
    : "password";

  const id = await p.text(t(locale, "askAccountId"), {
    default: suggestAccountId(email, taken),
    validate: (v) => (ACCOUNT_ID.test(v) && !taken.has(v) ? undefined : t(locale, "invalidAccountId")),
  });
  const displayName = (await p.text(t(locale, "askDisplayName"), { default: "" })).trim();

  const auth =
    method === "oauth" && oauthProvider
      ? { type: "oauth2" as const, provider: oauthProvider, ...(await askOAuthSettings(deps, oauthProvider, detected)) }
      : { type: "password" as const, ...(detected.usernameStyle === "localpart" ? { username: email.split("@")[0] } : {}) };

  let account = AccountSchema.parse({
    id,
    email,
    imap,
    smtp,
    auth,
    identities: displayName ? [{ email, name: displayName }] : [],
    locale,
  });

  const staged = new MemorySecretStore();
  const appPassword = detected.auth !== "password";
  let provider: AuthProvider;
  if (account.auth.type === "oauth2") {
    await signIn(deps, account, staged);
    provider = new OAuthAuthProvider(account, staged);
  } else {
    provider = await askPassword(deps, account, staged, appPassword);
  }

  for (let attempt = 0; ; attempt++) {
    p.print(t(locale, "testing"));
    const report = await deps.test(account, provider, detected.presetId);
    if (report.imap.ok) {
      p.print(
        t(locale, "imapOk", {
          folders: report.imap.folderCount,
          keywords: t(locale, report.imap.capabilities.customKeywords ? "yes" : "no"),
        }),
      );
    }
    if (report.smtp?.ok) p.print(t(locale, "smtpOk"));
    const failed = failures(report);
    if (failed.length === 0) break;
    for (const f of failed) {
      p.print(t(locale, "stepFailed", { step: t(locale, f.step === "imap" ? "stepImap" : "stepSmtp"), message: f.diagnosis.message[locale] }));
    }

    const pinCandidate = failed.find((f) => f.diagnosis.offerCertificatePinning);
    if (pinCandidate) {
      const endpoint = pinCandidate.step === "imap" ? account.imap : account.smtp!;
      const implicitPort = pinCandidate.step === "imap" ? 993 : 465;
      const info = await deps.probe({
        host: endpoint.host,
        port: endpoint.port,
        protocol: pinCandidate.step,
        security: endpoint.port === implicitPort ? "implicit" : "starttls",
      });
      p.print(t(locale, "certTitle", { host: endpoint.host }));
      p.print(
        t(locale, "certDetails", { subject: info.subject, issuer: info.issuer, from: info.validFrom.slice(0, 10), to: info.validTo.slice(0, 10), fingerprint: info.fingerprint256 }),
      );
      if (await p.confirm(t(locale, "certTrust"), false)) {
        account = AccountSchema.parse({
          ...account,
          [pinCandidate.step]: { ...endpoint, tlsFingerprint256: info.fingerprint256, tlsCertificatePem: info.pem },
        });
        if (account.auth.type === "oauth2") provider = new OAuthAuthProvider(account, staged);
        continue;
      }
    }

    const loginRejected = failed.some((f) => f.diagnosis.code === "auth_failed" || f.diagnosis.code === "app_password_required");
    if (loginRejected && account.auth.type === "password" && attempt < 2 && (await p.confirm(t(locale, "retryPassword"), true))) {
      provider = await askPassword(deps, account, staged, appPassword);
      continue;
    }
    if (!(await p.confirm(t(locale, "saveAnyway"), false))) {
      p.print(t(locale, "cancelled"));
      return undefined;
    }
    break;
  }

  p.print(t(locale, "permIntro"));
  const permissions = {
    read: await p.confirm(t(locale, "permRead"), true),
    write: await p.confirm(t(locale, "permWrite"), true),
    send: await p.confirm(t(locale, "permSend"), false),
    delete: await p.confirm(t(locale, "permDelete"), false),
  };
  account = AccountSchema.parse({ ...account, permissions });
  const makeDefault =
    existing !== undefined && (await p.confirm(t(locale, "askDefault", { id: account.id, current: defaultAccountId(existing) }), false));

  const config = ConfigSchema.parse(
    existing
      ? { ...existing, accounts: [...existing.accounts, account], ...(makeDefault ? { defaultAccount: account.id } : {}) }
      : { version: 2, accounts: [account] },
  );
  await deps.save(config, staged.entries(), []);
  p.print(t(locale, "saved"));
  p.print(t(locale, "nextSteps"));
  return config;
}

function defaultAccountId(config: AppConfig): string {
  return config.defaultAccount ?? config.accounts[0].id;
}

/** Each mailbox with what Claude may do there, so a forgotten or migrated one stands out. */
function printAccounts(deps: SetupDeps, config: AppConfig): void {
  const { prompter: p, locale } = deps;
  const tierKeys = { read: "tierRead", write: "tierWrite", send: "tierSend", delete: "tierDelete" } as const;
  p.print(t(locale, "accountsIntro"));
  for (const account of config.accounts) {
    const tiers = (Object.keys(tierKeys) as Array<keyof typeof tierKeys>).filter((tier) => account.permissions[tier]).map((tier) => t(locale, tierKeys[tier]));
    const line = t(locale, "accountLine", { id: account.id, email: account.email, tiers: tiers.length > 0 ? tiers.join(", ") : t(locale, "tierNone") });
    p.print(account.id === defaultAccountId(config) ? line + t(locale, "defaultMarker") : line);
    const locked = account.policy.folders.deny;
    if (locked.length > 0) p.print(`    ${t(locale, "lockedFolders", { list: locked.join(", ") })}`);
  }
}

async function removeAccount(deps: SetupDeps, config: AppConfig): Promise<AppConfig> {
  const { prompter: p, locale } = deps;
  if (config.accounts.length === 1) {
    p.print(t(locale, "cannotRemoveLast"));
    return config;
  }
  const id = await p.select(t(locale, "chooseAccount"), config.accounts.map((a) => ({ value: a.id, label: `${a.id} <${a.email}>` })));
  if (!(await p.confirm(`${t(locale, "menuRemove")}: ${id}?`, false))) return config;
  const next = ConfigSchema.parse({
    ...config,
    accounts: config.accounts.filter((a) => a.id !== id),
    defaultAccount: config.defaultAccount === id ? undefined : config.defaultAccount,
  });
  await deps.save(next, [], [id]);
  p.print(t(locale, "removed", { id }));
  return next;
}

async function reauthenticate(deps: SetupDeps, config: AppConfig): Promise<void> {
  const { prompter: p, locale } = deps;
  const oauthAccounts = config.accounts.filter((a) => a.auth.type === "oauth2");
  if (oauthAccounts.length === 0) {
    p.print(t(locale, "noOAuthAccounts"));
    return;
  }
  const id = await p.select(t(locale, "chooseAccount"), oauthAccounts.map((a) => ({ value: a.id, label: `${a.id} <${a.email}>` })));
  const staged = new MemorySecretStore();
  await signIn(deps, oauthAccounts.find((a) => a.id === id)!, staged);
  await deps.save(config, staged.entries(), []);
}

/** Interactive setup. Returns the process exit code. */
export async function runSetup(deps: SetupDeps): Promise<number> {
  const { prompter: p, locale } = deps;
  p.print(t(locale, "welcome"));
  if (deps.envMode) p.print(t(locale, "envMode"));
  try {
    let config = await deps.loadExisting();
    if (!config) return (await addAccount(deps, undefined)) ? 0 : 1;
    for (;;) {
      printAccounts(deps, config);
      const hasOAuth = config.accounts.some((a) => a.auth.type === "oauth2");
      const action = await p.select(
        t(locale, "menu"),
        [
          { value: "add" as const, label: t(locale, "menuAdd") },
          { value: "remove" as const, label: t(locale, "menuRemove") },
          ...(hasOAuth ? [{ value: "reauth" as const, label: t(locale, "menuReauth") }] : []),
          { value: "done" as const, label: t(locale, "menuDone") },
        ],
        "done",
      );
      if (action === "done") return 0;
      if (action === "add") config = (await addAccount(deps, config)) ?? config;
      if (action === "remove") config = await removeAccount(deps, config);
      if (action === "reauth") await reauthenticate(deps, config);
    }
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      p.print(t(locale, "cancelled"));
      return 130;
    }
    throw err;
  } finally {
    p.close();
  }
}
