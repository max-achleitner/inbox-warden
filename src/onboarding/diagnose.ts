import {
  OAuthAuthorizationError,
  OAuthConfigurationError,
  OAuthReauthRequiredError,
  OAuthSignInRequiredError,
  OAuthTokenError,
} from "../auth/oauth/errors.js";
import { SecretStoreUnavailableError } from "../secrets/keyring-store.js";
import { presetById, type LocalizedText } from "./presets.js";

/** imapflow sets `authenticationFailed`; nodemailer uses code "EAUTH". */
export function isAuthenticationFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { authenticationFailed?: unknown; code?: unknown };
  return e.authenticationFailed === true || e.code === "EAUTH";
}

export type DiagnosisCode =
  | "auth_failed"
  | "app_password_required"
  | "smtp_auth_disabled"
  | "basic_auth_disabled"
  | "certificate_untrusted"
  | "certificate_expired"
  | "certificate_hostname"
  | "certificate_pin_mismatch"
  | "starttls_missing"
  | "connection_refused"
  | "timeout"
  | "host_not_found"
  | "oauth_reauth"
  | "oauth_config"
  | "oauth_failed"
  | "keychain_unavailable"
  | "unknown";

export interface Diagnosis {
  code: DiagnosisCode;
  message: LocalizedText;
  /** The setup should offer to inspect and trust the server certificate. */
  offerCertificatePinning?: boolean;
}

export interface DiagnoseContext {
  protocol: "imap" | "smtp";
  host: string;
  port: number;
  presetId?: string;
}

const UNTRUSTED_CERT = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

function same(text: string): LocalizedText {
  return { de: text, en: text };
}

function serverText(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err);
  const e = err as { message?: unknown; response?: unknown; responseText?: unknown; serverResponseCode?: unknown };
  return [e.message, e.response, e.responseText, e.serverResponseCode].filter((x) => typeof x === "string").join(" ");
}

function authHint(ctx: DiagnoseContext): LocalizedText {
  const preset = ctx.presetId ? presetById(ctx.presetId) : undefined;
  const link = preset?.helpUrl ? ` ${preset.helpUrl}` : "";
  if (preset?.auth === "app-password") {
    return {
      de: `Anmeldung abgelehnt. ${preset.name} verlangt ein App-Passwort statt Ihres normalen Passworts.${link}`,
      en: `Login rejected. ${preset.name} requires an app password instead of your normal password.${link}`,
    };
  }
  if (preset && preset.notes.length > 0) {
    return {
      de: `Anmeldung abgelehnt. Bitte Benutzername und Passwort prüfen. Hinweis: ${preset.notes[0].de}${link}`,
      en: `Login rejected. Please check user name and password. Note: ${preset.notes[0].en}${link}`,
    };
  }
  return {
    de: "Anmeldung abgelehnt. Bitte Benutzername und Passwort prüfen. Manche Anbieter verlangen ein eigenes App-Passwort.",
    en: "Login rejected. Please check user name and password. Some providers require a separate app password.",
  };
}

/** Turn any connection or login error into a plain-language explanation with a next step. */
export function diagnose(err: unknown, ctx: DiagnoseContext): Diagnosis {
  const where = `${ctx.host}:${ctx.port}`;
  if (err instanceof OAuthReauthRequiredError || err instanceof OAuthSignInRequiredError) {
    return { code: "oauth_reauth", message: same(err.message) };
  }
  if (err instanceof OAuthConfigurationError) {
    return { code: "oauth_config", message: same(err.message) };
  }
  if (err instanceof OAuthAuthorizationError || err instanceof OAuthTokenError) {
    return { code: "oauth_failed", message: same(err.message) };
  }
  if (err instanceof SecretStoreUnavailableError) return { code: "keychain_unavailable", message: same(err.message) };

  const code = typeof err === "object" && err !== null ? String((err as { code?: unknown }).code ?? "") : "";
  const text = serverText(err);

  if (code === "ERR_CERT_PIN_MISMATCH") return { code: "certificate_pin_mismatch", message: same(text) };
  if (UNTRUSTED_CERT.has(code) || /self[- ]signed certificate/i.test(text)) {
    return {
      code: "certificate_untrusted",
      offerCertificatePinning: true,
      message: {
        de: `Das Zertifikat von ${where} ist nicht von einer bekannten Stelle signiert (typisch für eigene Server). Sie können es prüfen und gezielt vertrauen.`,
        en: `The certificate of ${where} is not signed by a known authority (typical for self-hosted servers). You can inspect it and trust exactly this certificate.`,
      },
    };
  }
  if (code === "CERT_HAS_EXPIRED") {
    return {
      code: "certificate_expired",
      message: {
        de: `Das Zertifikat von ${where} ist abgelaufen. Es muss auf dem Server erneuert werden.`,
        en: `The certificate of ${where} has expired and must be renewed on the server.`,
      },
    };
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return {
      code: "certificate_hostname",
      message: {
        de: `Das Zertifikat passt nicht zum Servernamen ${ctx.host}. Verwenden Sie den Servernamen aus der Anleitung Ihres Anbieters.`,
        en: `The certificate does not match the server name ${ctx.host}. Use the server name from your provider's instructions.`,
      },
    };
  }
  if ((err as { tlsFailed?: unknown })?.tlsFailed === true || code === "ETLS" || /does not support STARTTLS/i.test(text)) {
    return {
      code: "starttls_missing",
      message: {
        de: `${where} bietet keine Verschlüsselung (STARTTLS) an. Ohne Verschlüsselung würde das Passwort lesbar übertragen; versuchen Sie Port ${ctx.protocol === "imap" ? 993 : 465}.`,
        en: `${where} offers no encryption (STARTTLS). Without it the password would travel in clear text; try port ${ctx.protocol === "imap" ? 993 : 465}.`,
      },
    };
  }
  if (isAuthenticationFailure(err) || /authenticat|invalid credentials|login failed|535/i.test(text)) {
    if (/SmtpClientAuthentication is disabled/i.test(text)) {
      return {
        code: "smtp_auth_disabled",
        message: {
          de: "Microsoft 365 hat das Senden über SMTP für dieses Postfach deaktiviert. Ein Administrator muss „Authenticated SMTP“ aktivieren (siehe docs/guide/providers.md).",
          en: "Microsoft 365 has SMTP sending disabled for this mailbox. An administrator must enable Authenticated SMTP (see docs/guide/providers.md).",
        },
      };
    }
    if (/basic authentication is disabled|5\.7\.139/i.test(text)) {
      return {
        code: "basic_auth_disabled",
        message: {
          de: "Der Anbieter erlaubt keine Anmeldung mit Passwort mehr. Bitte die Microsoft-Anmeldung (OAuth) wählen.",
          en: "The provider no longer accepts password logins. Please choose the Microsoft sign-in (OAuth).",
        },
      };
    }
    if (/application-specific password required|5\.7\.9/i.test(text)) {
      return {
        code: "app_password_required",
        message: {
          de: "Der Anbieter verlangt ein App-Passwort. https://support.google.com/accounts/answer/185833",
          en: "The provider requires an app password. https://support.google.com/accounts/answer/185833",
        },
      };
    }
    return { code: "auth_failed", message: authHint(ctx) };
  }
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return {
      code: "connection_refused",
      message: {
        de: `${where} nimmt keine Verbindung an. Servername und Port prüfen; eine Firewall kann den Port blockieren.`,
        en: `${where} refuses the connection. Check server name and port; a firewall may block the port.`,
      },
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      code: "host_not_found",
      message: { de: `Den Server ${ctx.host} gibt es nicht (Tippfehler?).`, en: `The server ${ctx.host} does not exist (typo?).` },
    };
  }
  if (/TIMEOUT|ETIMEDOUT|ESOCKET/.test(code) || /timed? ?out/i.test(text)) {
    return {
      code: "timeout",
      message: {
        de: `${where} antwortet nicht. Servername, Port und Internetverbindung prüfen.`,
        en: `${where} does not answer. Check server name, port and your internet connection.`,
      },
    };
  }
  return { code: "unknown", message: same(text || "Unknown error") };
}
