import type Mail from "nodemailer/lib/mailer/index.js";
import { convert } from "html-to-text";
import type { Identity } from "../config/schema.js";

/** "Maximilian Achleitner <max@…>" when a display name is configured, otherwise the bare address. */
export function fromHeader(identity: Identity): Mail.Address | string {
  return identity.name ? { name: identity.name, address: identity.email } : identity.email;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Append the identity's signature after the standard "-- " separator (RFC 3676 §4.3). */
export function withSignature(
  body: { text: string; html?: string },
  identity: Identity,
  enabled: boolean,
): { text: string; html?: string } {
  if (!enabled || (!identity.signature && !identity.signatureHtml)) return body;
  const textSignature = identity.signature ?? convert(identity.signatureHtml ?? "", { wordwrap: false });
  const htmlSignature = identity.signatureHtml ?? escapeHtml(identity.signature ?? "").replace(/\r?\n/g, "<br>");
  return {
    text: `${body.text.trimEnd()}\n\n-- \n${textSignature}`,
    html: body.html === undefined ? undefined : `${body.html}<br><br>-- <br>${htmlSignature}`,
  };
}
