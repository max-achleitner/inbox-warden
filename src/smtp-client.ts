import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { Credentials } from "./credentials.js";
import * as log from "./logging/logger.js";

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

  log.info("smtp.configured", { server: creds.smtpHost, port: creds.smtpPort });
  return transport;
}
