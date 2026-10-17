import nodemailer from "nodemailer";
import type { MailTransport } from "../../mail/send.js";

export interface CapturedMail {
  envelope: { from: string; to: string[] };
  raw: Buffer;
}

export interface CaptureTransport {
  transport: MailTransport;
  sent: CapturedMail[];
  /** Make the next sendMail() fail with this error. */
  failNext(err: Error): void;
}

/**
 * A nodemailer transport that behaves like the SMTP transport (Bcc header is stripped,
 * explicit envelope wins) but records messages instead of delivering them.
 * nodemailer's streamTransport/jsonTransport keep Bcc, so they cannot be used to test Bcc handling.
 */
export function createCaptureTransport(): CaptureTransport {
  const sent: CapturedMail[] = [];
  let nextError: Error | null = null;
  const transport = nodemailer.createTransport({
    name: "capture",
    version: "1.0.0",
    send(mail: any, callback: (err: Error | null, info?: unknown) => void) {
      if (nextError) {
        const err = nextError;
        nextError = null;
        callback(err);
        return;
      }
      const envelope = mail.data.envelope || mail.message.getEnvelope();
      const messageId = mail.message.messageId();
      mail.message.build((err: Error | null, raw: Buffer) => {
        if (err) return callback(err);
        sent.push({ envelope, raw });
        callback(null, { envelope, messageId, accepted: envelope.to, rejected: [], response: "250 OK" });
      });
    },
  } as any);
  return { transport, sent, failNext: (err) => { nextError = err; } };
}
