import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";

/** Build an RFC 822 message for fixtures. Bcc is kept so Sent/Draft fixtures look realistic. */
export async function buildRaw(opts: Mail.Options): Promise<Buffer> {
  const node = new MailComposer({ date: new Date("2026-01-15T10:00:00Z"), ...opts }).compile();
  node.keepBcc = true;
  return node.build();
}

/** Split a raw message into its header block (unfolded lines) and body. */
export function headerLines(raw: Buffer | string): string[] {
  const s = raw.toString();
  const head = s.slice(0, s.search(/\r?\n\r?\n/));
  return head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
}

export function header(raw: Buffer | string, name: string): string | undefined {
  const line = headerLines(raw).find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line?.slice(name.length + 1).trim();
}
