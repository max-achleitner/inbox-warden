import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";

export interface OutgoingAttachment {
  filename: string;
  /** base64-encoded file content */
  content: string;
  contentType: string;
}

export interface ComposeInput {
  from: string | Mail.Address;
  to: string | Array<string | Mail.Address>;
  cc?: string | Array<string | Mail.Address>;
  bcc?: string | Array<string | Mail.Address>;
  replyTo?: string | Mail.Address;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string | string[];
  attachments?: OutgoingAttachment[];
  date?: Date;
}

export interface ComposedMessage {
  /** Complete message including the Bcc header — what Drafts and Sent must contain. */
  raw: Buffer;
  messageId: string;
  /** SMTP envelope; `to` already contains Cc and Bcc recipients. */
  envelope: { from: string; to: string[] };
}

/**
 * Build an RFC 5322 message with nodemailer's MailComposer. It takes care of RFC 2047 headers,
 * RFC 2231 attachment filenames (e.g. "Angebot_Größe.pdf"), header-injection-safe values,
 * quoted-printable for long lines and a Message-ID on the sender's domain.
 */
export async function composeMessage(input: ComposeInput): Promise<ComposedMessage> {
  const node = new MailComposer({
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: input.replyTo,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    date: input.date ?? new Date(),
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      encoding: "base64",
      contentType: a.contentType,
      // nodemailer marks message/rfc822 parts "inline", so clients would show a forwarded .eml as the body
      contentDisposition: "attachment" as const,
    })),
  }).compile();
  node.keepBcc = true;
  const messageId = node.messageId();
  const envelope = node.getEnvelope();
  const raw = await node.build();
  return { raw, messageId, envelope: { from: envelope.from || "", to: envelope.to } };
}
