export type AuthKind = "password" | "app-password" | "oauth2-microsoft" | "oauth2-google" | "bridge-password";

export interface ServerSetting {
  host: string;
  port: number;
  /** Must agree with connection-security.ts: implicit TLS only on 993 (IMAP) / 465 (SMTP). */
  security: "implicit" | "starttls";
}

export interface LocalizedText {
  de: string;
  en: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  /** Email domains that identify the provider without any lookup. */
  domains: string[];
  imap: ServerSetting;
  smtp: ServerSetting;
  auth: AuthKind;
  /** Login name: the full address (default) or only the part before "@". */
  usernameStyle?: "address" | "localpart";
  /** Microsoft authority tenant for oauth2-microsoft presets. */
  tenant?: string;
  helpUrl?: string;
  notes: LocalizedText[];
}

const implicitImap = (host: string): ServerSetting => ({ host, port: 993, security: "implicit" });
const implicitSmtp = (host: string): ServerSetting => ({ host, port: 465, security: "implicit" });
const submission = (host: string): ServerSetting => ({ host, port: 587, security: "starttls" });

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "gmail",
    name: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    imap: implicitImap("imap.gmail.com"),
    smtp: implicitSmtp("smtp.gmail.com"),
    auth: "app-password",
    helpUrl: "https://support.google.com/accounts/answer/185833",
    notes: [
      {
        de: "Gmail verlangt ein App-Passwort. Dafür muss die Bestätigung in zwei Schritten aktiv sein.",
        en: "Gmail requires an app password, which needs 2-Step Verification to be turned on.",
      },
    ],
  },
  {
    id: "google-workspace",
    name: "Google Workspace",
    domains: [],
    imap: implicitImap("imap.gmail.com"),
    smtp: implicitSmtp("smtp.gmail.com"),
    auth: "oauth2-google",
    notes: [
      {
        de: "Anmeldung über den internen OAuth-Client Ihrer Organisation (siehe docs/guide/providers.md) oder – falls vom Administrator erlaubt – mit einem App-Passwort.",
        en: "Sign in with your organisation's internal OAuth client (see docs/guide/providers.md) or, if your administrator allows it, with an app password.",
      },
    ],
  },
  {
    id: "microsoft365",
    name: "Microsoft 365",
    domains: [],
    imap: implicitImap("outlook.office365.com"),
    smtp: submission("smtp.office365.com"),
    auth: "oauth2-microsoft",
    tenant: "organizations",
    helpUrl: "https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/authenticated-client-smtp-submission",
    notes: [
      {
        de: "Zum Senden muss ein Administrator „Authenticated SMTP“ für das Postfach aktivieren.",
        en: "To send mail, an administrator must enable Authenticated SMTP for the mailbox.",
      },
      {
        de: "Vorschau: Eine eigene Microsoft-App wird noch nicht mitgeliefert. Ihr Administrator registriert sie einmalig und gibt Ihnen die Client-ID (siehe docs/guide/providers.md).",
        en: "Preview: no Microsoft app is included yet. Your administrator registers it once and gives you the client ID (see docs/guide/providers.md).",
      },
    ],
  },
  {
    id: "outlook-com",
    name: "Outlook.com",
    domains: ["outlook.com", "outlook.de", "outlook.at", "hotmail.com", "hotmail.de", "live.com", "live.de", "live.at", "msn.com"],
    imap: implicitImap("outlook.office365.com"),
    smtp: submission("smtp-mail.outlook.com"),
    auth: "oauth2-microsoft",
    tenant: "consumers",
    notes: [
      {
        de: "Vorschau: Persönliche Microsoft-Konten benötigen eine App-Registrierung, die persönliche Konten zulässt; eine solche wird noch nicht mitgeliefert.",
        en: "Preview: personal Microsoft accounts need an app registration that allows personal accounts; none is included yet.",
      },
    ],
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: implicitImap("imap.mail.me.com"),
    smtp: submission("smtp.mail.me.com"),
    auth: "app-password",
    helpUrl: "https://support.apple.com/en-us/102654",
    notes: [{ de: "iCloud verlangt ein app-spezifisches Passwort.", en: "iCloud requires an app-specific password." }],
  },
  {
    id: "yahoo",
    name: "Yahoo Mail",
    domains: ["yahoo.com", "yahoo.de", "yahoo.at", "ymail.com", "rocketmail.com"],
    imap: implicitImap("imap.mail.yahoo.com"),
    smtp: implicitSmtp("smtp.mail.yahoo.com"),
    auth: "app-password",
    helpUrl: "https://help.yahoo.com/kb/SLN15241.html",
    notes: [{ de: "Yahoo verlangt ein App-Passwort.", en: "Yahoo requires an app password." }],
  },
  {
    id: "gmx",
    name: "GMX",
    domains: ["gmx.de", "gmx.at", "gmx.ch", "gmx.net", "gmx.eu", "gmx.biz", "gmx.org", "gmx.info"],
    imap: implicitImap("imap.gmx.net"),
    smtp: implicitSmtp("mail.gmx.net"),
    auth: "password",
    helpUrl: "https://hilfe.gmx.net/pop-imap/einschalten.html",
    notes: [
      {
        de: "In den GMX-Einstellungen muss „POP3/IMAP Abruf“ eingeschaltet sein. Mit Zwei-Faktor-Anmeldung ist ein anwendungsspezifisches Passwort nötig.",
        en: 'Turn on "POP3/IMAP access" in the GMX settings. With two-factor login an application-specific password is required.',
      },
    ],
  },
  {
    id: "webde",
    name: "WEB.DE",
    domains: ["web.de"],
    imap: implicitImap("imap.web.de"),
    smtp: submission("smtp.web.de"),
    auth: "password",
    usernameStyle: "localpart",
    helpUrl: "https://hilfe.web.de/pop-imap/einschalten.html",
    notes: [
      {
        de: "In den WEB.DE-Einstellungen muss „POP3/IMAP Abruf“ eingeschaltet sein. Mit Zwei-Faktor-Anmeldung ist ein anwendungsspezifisches Passwort nötig.",
        en: 'Turn on "POP3/IMAP access" in the WEB.DE settings. With two-factor login an application-specific password is required.',
      },
    ],
  },
  {
    id: "ionos",
    name: "IONOS",
    domains: ["ionos.de"],
    imap: implicitImap("imap.ionos.de"),
    smtp: implicitSmtp("smtp.ionos.de"),
    auth: "password",
    notes: [
      {
        de: "IONOS akzeptiert nur Absenderadressen Ihrer eigenen Domain.",
        en: "IONOS only accepts sender addresses of your own domain.",
      },
    ],
  },
  {
    id: "strato",
    name: "STRATO",
    domains: ["strato.de"],
    imap: implicitImap("imap.strato.de"),
    smtp: implicitSmtp("smtp.strato.de"),
    auth: "password",
    notes: [],
  },
  {
    id: "t-online",
    name: "Telekom (t-online.de)",
    domains: ["t-online.de", "magenta.de"],
    imap: implicitImap("secureimap.t-online.de"),
    smtp: implicitSmtp("securesmtp.t-online.de"),
    auth: "password",
    helpUrl: "https://www.telekom.de/hilfe/festnetz-internet-tv/e-mail/e-mail-passwort",
    notes: [
      {
        de: "Verwenden Sie das separate E-Mail-Passwort aus dem Telekom Kundencenter, nicht Ihr Login-Passwort.",
        en: "Use the separate e-mail password from the Telekom customer centre, not your login password.",
      },
    ],
  },
  {
    id: "mailbox-org",
    name: "mailbox.org",
    domains: ["mailbox.org"],
    imap: implicitImap("imap.mailbox.org"),
    smtp: implicitSmtp("smtp.mailbox.org"),
    auth: "password",
    notes: [],
  },
  {
    id: "posteo",
    name: "Posteo",
    domains: ["posteo.de", "posteo.net", "posteo.at", "posteo.ch", "posteo.org", "posteo.eu"],
    imap: implicitImap("posteo.de"),
    smtp: implicitSmtp("posteo.de"),
    auth: "password",
    notes: [],
  },
  {
    id: "proton-bridge",
    name: "Proton Mail (Bridge)",
    domains: ["proton.me", "protonmail.com", "protonmail.ch", "pm.me"],
    imap: { host: "127.0.0.1", port: 1143, security: "starttls" },
    smtp: { host: "127.0.0.1", port: 1025, security: "starttls" },
    auth: "bridge-password",
    helpUrl: "https://proton.me/mail/bridge",
    notes: [
      {
        de: "Proton Mail Bridge muss laufen. Verwenden Sie das Bridge-Passwort und vertrauen Sie im Setup dem Zertifikat der Bridge.",
        en: "Proton Mail Bridge must be running. Use the Bridge password and trust the Bridge certificate during setup.",
      },
    ],
  },
];

/** MX host patterns that identify a provider for custom domains. */
export const MX_RULES: Array<{ pattern: RegExp; presetId: string }> = [
  { pattern: /\.mail\.protection\.outlook\.com\.?$/i, presetId: "microsoft365" },
  { pattern: /(^|\.)(google\.com|googlemail\.com)\.?$/i, presetId: "google-workspace" },
  { pattern: /(^|\.)(ionos\.[a-z.]+|kundenserver\.de)\.?$/i, presetId: "ionos" },
  { pattern: /(^|\.)rzone\.de\.?$/i, presetId: "strato" },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
