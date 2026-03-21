import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { Credentials } from "./credentials.js";

/** Create an SMTP transport for sending emails */
export function createSmtpTransport(creds: Credentials): Transporter {
  const transport = nodemailer.createTransport({
    host: creds.smtpHost,
    port: creds.smtpPort,
    secure: creds.smtpPort === 465,
    auth: {
      user: creds.user,
      pass: creds.password,
    },
  });

  console.error(`[SMTP] Transport configured for ${creds.smtpHost}`);
  return transport;
}
