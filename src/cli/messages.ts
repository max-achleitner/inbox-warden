import { SERVER_NAME } from "../version.js";

export type Locale = "de" | "en";

/** IMAP_MCP_LANG wins; otherwise LANG/LC_ALL, then the OS locale. */
export function detectLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const explicit = env.IMAP_MCP_LANG?.toLowerCase();
  if (explicit === "de" || explicit === "en") return explicit;
  const fromEnv = (env.LC_ALL || env.LANG || "").toLowerCase();
  if (fromEnv) return fromEnv.startsWith("de") ? "de" : "en";
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("de") ? "de" : "en";
}

const MESSAGES = {
  welcome: { de: "=== E-Mail für Claude einrichten ===", en: "=== Set up email for Claude ===" },
  envMode: {
    de: "Hinweis: Diese Installation wird über Umgebungsvariablen (z. B. Claude-Desktop-Erweiterung) konfiguriert. Das Setup bearbeitet ~/.imap-mcp/config.json.",
    en: "Note: this installation is configured through environment variables (e.g. the Claude Desktop extension). Setup edits ~/.imap-mcp/config.json.",
  },
  menu: { de: "Was möchten Sie tun?", en: "What would you like to do?" },
  menuAdd: { de: "Postfach hinzufügen", en: "Add a mailbox" },
  menuRemove: { de: "Postfach entfernen", en: "Remove a mailbox" },
  menuReauth: { de: "Neu anmelden (Microsoft/Google)", en: "Sign in again (Microsoft/Google)" },
  menuDone: { de: "Fertig", en: "Done" },
  chooseAccount: { de: "Welches Postfach?", en: "Which mailbox?" },
  askEmail: { de: "E-Mail-Adresse", en: "Email address" },
  invalidEmail: { de: "Das ist keine gültige E-Mail-Adresse.", en: "That is not a valid email address." },
  detecting: { de: "Suche die Servereinstellungen …", en: "Looking up the server settings …" },
  detected: { de: "Erkannt: {name}", en: "Detected: {name}" },
  serverLine: { de: "  {protocol}: {host}:{port}", en: "  {protocol}: {host}:{port}" },
  helpLink: { de: "Anleitung: {url}", en: "Instructions: {url}" },
  useDetected: { de: "Diese Einstellungen verwenden?", en: "Use these settings?" },
  askImapHost: { de: "IMAP-Server", en: "IMAP server" },
  askImapPort: { de: "IMAP-Port", en: "IMAP port" },
  askSmtpHost: { de: "SMTP-Server", en: "SMTP server" },
  askSmtpPort: { de: "SMTP-Port", en: "SMTP port" },
  invalidPort: { de: "Bitte eine Zahl zwischen 1 und 65535 eingeben.", en: "Please enter a number between 1 and 65535." },
  askAuthMethod: { de: "Wie möchten Sie sich anmelden?", en: "How do you want to sign in?" },
  authOAuth: { de: "Mit {provider}-Konto im Browser (empfohlen)", en: "With your {provider} account in the browser (recommended)" },
  authPassword: { de: "Mit (App-)Passwort", en: "With an (app) password" },
  askAccountId: { de: "Kurzname für dieses Postfach", en: "Short name for this mailbox" },
  invalidAccountId: {
    de: "Nur Kleinbuchstaben, Ziffern und Bindestrich (max. 32), noch nicht vergeben.",
    en: "Lowercase letters, digits and dashes only (max. 32), not yet in use.",
  },
  askDisplayName: { de: "Absendername (z. B. Max Mustermann, leer = keiner)", en: "Sender name (e.g. Jane Doe, empty = none)" },
  askPassword: { de: "Passwort (wird nicht angezeigt)", en: "Password (hidden)" },
  askAppPassword: { de: "App-Passwort (wird nicht angezeigt)", en: "App password (hidden)" },
  askClientId: { de: "Anwendungs-ID (Client-ID) der App-Registrierung", en: "Application (client) ID of the app registration" },
  askTenant: { de: "Mandant (Domain oder ID, leer = beliebige Organisation)", en: "Tenant (domain or ID, empty = any organisation)" },
  askGoogleClientId: { de: "Google OAuth Client-ID", en: "Google OAuth client ID" },
  askGoogleSecret: { de: "Google OAuth Client-Secret (wird nicht angezeigt)", en: "Google OAuth client secret (hidden)" },
  askSignInMode: { de: "Wo melden Sie sich an?", en: "Where do you sign in?" },
  signInBrowser: { de: "Im Browser auf diesem Computer", en: "In the browser on this computer" },
  signInCode: { de: "Mit einem Code auf einem anderen Gerät", en: "With a code on another device" },
  signedIn: { de: "Angemeldet.", en: "Signed in." },
  testing: { de: "Teste die Verbindung …", en: "Testing the connection …" },
  imapOk: {
    de: "✓ Empfangen (IMAP): verbunden, {folders} Ordner. Eigene Markierungen: {keywords}.",
    en: "✓ Receiving (IMAP): connected, {folders} folders. Custom labels: {keywords}.",
  },
  smtpOk: { de: "✓ Senden (SMTP): Anmeldung erfolgreich.", en: "✓ Sending (SMTP): login successful." },
  stepFailed: { de: "✗ {step}: {message}", en: "✗ {step}: {message}" },
  stepImap: { de: "Empfangen (IMAP)", en: "Receiving (IMAP)" },
  stepSmtp: { de: "Senden (SMTP)", en: "Sending (SMTP)" },
  yes: { de: "ja", en: "yes" },
  no: { de: "nein", en: "no" },
  certTitle: { de: "Zertifikat des Servers {host}:", en: "Certificate of server {host}:" },
  certDetails: {
    de: "  Ausgestellt für: {subject}\n  Aussteller: {issuer}\n  Gültig: {from} bis {to}\n  SHA-256: {fingerprint}",
    en: "  Issued to: {subject}\n  Issuer: {issuer}\n  Valid: {from} to {to}\n  SHA-256: {fingerprint}",
  },
  certTrust: {
    de: "Diesem Zertifikat vertrauen? Nur bestätigen, wenn es Ihr eigener Server ist und der Fingerabdruck stimmt.",
    en: "Trust this certificate? Only confirm if this is your own server and the fingerprint is correct.",
  },
  retryPassword: { de: "Passwort erneut eingeben?", en: "Enter the password again?" },
  saveAnyway: { de: "Trotzdem speichern?", en: "Save anyway?" },
  permIntro: {
    de: "Was darf Claude mit diesem Postfach tun? (Später änderbar.)",
    en: "What may Claude do with this mailbox? (Can be changed later.)",
  },
  permRead: { de: "E-Mails lesen und suchen", en: "Read and search emails" },
  permWrite: { de: "Ordnen, markieren, Entwürfe anlegen", en: "Organise, flag, create drafts" },
  permSend: {
    de: "Selbst E-Mails senden (empfohlen: nein – Claude schreibt Entwürfe, Sie senden)",
    en: "Send emails itself (recommended: no – Claude writes drafts, you send)",
  },
  permDelete: { de: "E-Mails löschen", en: "Delete emails" },
  saved: { de: "Gespeichert. Passwörter liegen im Schlüsselbund des Betriebssystems.", en: "Saved. Secrets are stored in the operating system's keychain." },
  nextSteps: {
    de: `Nächster Schritt: Claude Desktop neu starten. Prüfen jederzeit mit: ${SERVER_NAME} doctor`,
    en: `Next step: restart Claude Desktop. Check any time with: ${SERVER_NAME} doctor`,
  },
  askDefault: {
    de: "Soll „{id}“ das Standardpostfach werden? Claude nutzt es, wenn kein Postfach genannt wird. (Bisher: {current})",
    en: 'Make "{id}" the default mailbox? Claude uses it when no mailbox is named. (Currently: {current})',
  },
  accountsIntro: { de: "Eingerichtete Postfächer:", en: "Configured mailboxes:" },
  accountLine: { de: "  {id} <{email}>: {tiers}", en: "  {id} <{email}>: {tiers}" },
  defaultMarker: { de: " (Standard)", en: " (default)" },
  tierRead: { de: "lesen", en: "read" },
  tierWrite: { de: "ordnen", en: "organise" },
  tierSend: { de: "senden", en: "send" },
  tierDelete: { de: "löschen", en: "delete" },
  tierNone: { de: "nichts erlaubt", en: "nothing allowed" },
  removed: { de: "Postfach „{id}“ entfernt.", en: 'Mailbox "{id}" removed.' },
  cannotRemoveLast: {
    de: "Das letzte Postfach kann nicht entfernt werden. Zum Zurücksetzen den Ordner ~/.imap-mcp löschen.",
    en: "The last mailbox cannot be removed. To reset, delete the folder ~/.imap-mcp.",
  },
  noOAuthAccounts: { de: "Kein Postfach verwendet eine Microsoft- oder Google-Anmeldung.", en: "No mailbox uses a Microsoft or Google sign-in." },
  cancelled: { de: "Abgebrochen. Nichts wurde gespeichert.", en: "Cancelled. Nothing was saved." },
  doctorTitle: { de: "=== Prüfung der E-Mail-Einrichtung ===", en: "=== Email setup check ===" },
  configOk: { de: "✓ Konfiguration geladen ({count} Postfach/Postfächer)", en: "✓ Configuration loaded ({count} mailbox(es))" },
  configFailed: { de: "✗ Konfiguration: {message}", en: "✗ Configuration: {message}" },
  runSetup: { de: `  → Einrichten mit: ${SERVER_NAME} setup`, en: `  → Set up with: ${SERVER_NAME} setup` },
  secretOk: { de: "✓ Zugangsdaten gespeichert", en: "✓ Credentials stored" },
  secretMissing: {
    de: `✗ Keine Zugangsdaten gespeichert → ${SERVER_NAME} setup ausführen und das Postfach neu anlegen`,
    en: `✗ No credentials stored → run ${SERVER_NAME} setup and add the mailbox again`,
  },
  secretFailed: { de: "✗ Zugangsdaten: {message}", en: "✗ Credentials: {message}" },
  tlsImplicit: { de: "• {protocol}: verschlüsselt (TLS, Port {port})", en: "• {protocol}: encrypted (TLS, port {port})" },
  tlsStartTls: { de: "• {protocol}: verschlüsselt (STARTTLS verpflichtend, Port {port})", en: "• {protocol}: encrypted (mandatory STARTTLS, port {port})" },
  tlsPinned: { de: "• {protocol}: verschlüsselt, festgelegtes Zertifikat {fingerprint}", en: "• {protocol}: encrypted, pinned certificate {fingerprint}" },
  tlsLoopback: {
    de: "• {protocol}: lokale Verbindung {host}:{port} (Verschlüsselung optional)",
    en: "• {protocol}: local connection {host}:{port} (encryption optional)",
  },
  smtpMissing: { de: "• Senden: kein SMTP-Server eingetragen", en: "• Sending: no SMTP server configured" },
  permissionsLine: { de: "• Rechte: {list}", en: "• Permissions: {list}" },
  lockedFoldersLine: { de: "• Gesperrte Ordner: {list}", en: "• Locked folders: {list}" },
  lockMatchesNothing: {
    de: "⚠ Ordnersperre „{pattern}“ passt auf keinen Ordner – Tippfehler? Dann bleibt der gemeinte Ordner für Claude sichtbar.",
    en: '⚠ Folder lock "{pattern}" matches no folder – a typo? Then the folder you meant stays visible to Claude.',
  },
  doctorOk: { de: "Alles in Ordnung.", en: "Everything is fine." },
  doctorProblems: { de: "{count} Problem(e) gefunden.", en: "{count} problem(s) found." },
  doctorWarnings: { de: "Keine Probleme, aber {count} Warnung(en) (⚠).", en: "No problems, but {count} warning(s) (⚠)." },
  accountsEmpty: { de: "Keine Postfächer eingerichtet.", en: "No mailboxes configured." },
  usage: {
    de:
      "Verwendung:\n" +
      `  ${SERVER_NAME} setup                        Postfach einrichten oder entfernen, neu anmelden\n` +
      `  ${SERVER_NAME} doctor                       Einrichtung prüfen (Exit-Code 1 bei Problemen)\n` +
      `  ${SERVER_NAME} accounts list                Eingerichtete Postfächer anzeigen\n` +
      `  ${SERVER_NAME} accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]\n` +
      "                                             Microsoft-/Google-Anmeldung (erneut) durchführen\n" +
      `  ${SERVER_NAME} accounts edit <id> [--allow|--deny <read|write|send|delete>] [--default]\n` +
      "                                [--max-messages <n>] [--max-delete <n>] [--password]\n" +
      "                                [--lock-folder <ordner>] [--unlock-folder <ordner>]\n" +
      "                                             Berechtigungen, Standard-Postfach, Massenlimits, gesperrte Ordner\n" +
      "                                             oder Passwort ändern\n" +
      `  ${SERVER_NAME} audit verify [<ordner|datei>]\n` +
      "                                             Prüfprotokoll auf Manipulation prüfen (Exit-Code 1 bei Problemen)",
    en:
      "Usage:\n" +
      `  ${SERVER_NAME} setup                        Add or remove mailboxes, sign in again\n` +
      `  ${SERVER_NAME} doctor                       Check the setup (exit code 1 on problems)\n` +
      `  ${SERVER_NAME} accounts list                Show the configured mailboxes\n` +
      `  ${SERVER_NAME} accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]\n` +
      "                                             Sign in (again) to Microsoft/Google\n" +
      `  ${SERVER_NAME} accounts edit <id> [--allow|--deny <read|write|send|delete>] [--default]\n` +
      "                                [--max-messages <n>] [--max-delete <n>] [--password]\n" +
      "                                [--lock-folder <folder>] [--unlock-folder <folder>]\n" +
      "                                             Change permissions, default mailbox, bulk limits, locked folders\n" +
      "                                             or password\n" +
      `  ${SERVER_NAME} audit verify [<folder|file>]\n` +
      "                                             Check the audit log for tampering (exit code 1 on problems)",
  },
  auditEmpty: { de: "Keine Einträge im Prüfprotokoll ({path}).", en: "No audit records found in {path}." },
  auditUnreadable: {
    de: "Das Prüfprotokoll unter {path} kann nicht gelesen werden: {message}",
    en: "Cannot read the audit log at {path}: {message}",
  },
  auditChecked: {
    de: "{records} Einträge in {files} Datei(en) geprüft, Nummern {first}–{last}.",
    en: "Checked {records} records in {files} file(s), sequence {first}–{last}.",
  },
  auditAnchored: {
    de: "Ältere Einträge wurden nach Ablauf der Aufbewahrungsfrist ({days} Tage) gelöscht; geprüft wird ab dem ältesten vorhandenen Eintrag.",
    en: "Older records were removed by the retention policy ({days} days); the chain is verified from the oldest remaining record.",
  },
  auditOk: { de: "OK: Das Prüfprotokoll ist vollständig und unverändert.", en: "OK: the audit log is complete and unmodified." },
  auditHead: {
    de: "Letzter Hash: {hash} (an anderer Stelle aufbewahren, um ein späteres Kürzen zu erkennen)",
    en: "Head hash: {hash} (store this value elsewhere to detect later truncation)",
  },
  auditFailed: { de: "FEHLER: {count} Problem(e) gefunden:", en: "FAILED: {count} problem(s) found:" },
  loginUnknownAccount: {
    de: "Es gibt kein Postfach „{id}“. Vorhanden: {ids}.",
    en: 'There is no mailbox "{id}". Configured: {ids}.',
  },
  loginNotOAuth: {
    de: `Das Postfach „{id}“ meldet sich mit Passwort an; eine Anmeldung im Browser ist nicht nötig. Passwort ändern: ${SERVER_NAME} accounts edit {id} --password`,
    en: `The mailbox "{id}" signs in with a password; no browser sign-in is needed. To change the password: ${SERVER_NAME} accounts edit {id} --password`,
  },
  editNoConfig: {
    de: `Es gibt noch keine Konfigurationsdatei. Postfach einrichten mit: ${SERVER_NAME} setup`,
    en: `There is no configuration file yet. Set up a mailbox with: ${SERVER_NAME} setup`,
  },
  editNotPassword: {
    de: `Das Postfach „{id}“ meldet sich mit Microsoft/Google an, nicht mit Passwort. Neu anmelden: ${SERVER_NAME} accounts login {id}. Nichts wurde geändert.`,
    en: `The mailbox "{id}" signs in with Microsoft/Google, not with a password. Sign in again: ${SERVER_NAME} accounts login {id}. Nothing was changed.`,
  },
  editAskPassword: { de: "Neues Passwort für {email} (wird nicht angezeigt)", en: "New password for {email} (hidden)" },
  editEmptyPassword: { de: "Kein Passwort eingegeben. Nichts wurde geändert.", en: "No password entered. Nothing was changed." },
  editInvalid: { de: "✗ Die Änderung ergibt keine gültige Konfiguration: {message} Nichts wurde geändert.", en: "✗ The change would make the configuration invalid: {message} Nothing was changed." },
  editSaved: { de: "✓ Postfach „{id}“ geändert:", en: '✓ Mailbox "{id}" changed:' },
  editLine: { de: "  {name}: {before} → {after}", en: "  {name}: {before} → {after}" },
  editPassword: { de: "  Passwort: neu gespeichert", en: "  password: stored" },
  editUnchanged: { de: "Alles war schon so eingestellt. Nichts wurde geändert.", en: "Everything was already set like this. Nothing was changed." },
  editRestart: {
    de: "Der laufende MCP-Server übernimmt die Änderung erst nach einem Neustart (in Claude: Server neu verbinden).",
    en: "A running MCP server picks up the change after a restart (in Claude: reconnect the server).",
  },
  editFailed: { de: "✗ Ändern fehlgeschlagen: {message}", en: "✗ Editing failed: {message}" },
  stateOn: { de: "an", en: "on" },
  stateOff: { de: "aus", en: "off" },
  editDefaultName: { de: "Standard-Postfach", en: "default account" },
  editNotLocked: {
    de: "„{folder}“ ist im Postfach „{id}“ nicht gesperrt. Gesperrte Ordner: {list}. Bitte genau so schreiben wie dort. Nichts wurde geändert.",
    en: '"{folder}" is not a locked folder of the mailbox "{id}". Locked folders: {list}. Write it exactly as listed there. Nothing was changed.',
  },
  lockedFoldersName: { de: "gesperrte Ordner", en: "locked folders" },
  lockedFolders: { de: "gesperrte Ordner: {list}", en: "locked folders: {list}" },
  foldersNone: { de: "keine", en: "none" },
  loginNoDeviceCode: {
    de: "{provider} bietet keine Anmeldung mit Code. Verwenden Sie --no-browser und öffnen Sie den angezeigten Link.",
    en: "{provider} offers no sign-in with a code. Use --no-browser and open the link that is shown.",
  },
  loginSuccess: { de: "✓ Angemeldet: {email}. Die Anmeldung ist gespeichert.", en: "✓ Signed in: {email}. The sign-in has been saved." },
  loginFailed: { de: "✗ Anmeldung fehlgeschlagen: {message}", en: "✗ Sign-in failed: {message}" },
} satisfies Record<string, { de: string; en: string }>;

export type MessageKey = keyof typeof MESSAGES;

export function t(locale: Locale, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return MESSAGES[key][locale].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
