import { ImapFlow } from "imapflow";
import type { Credentials } from "./credentials.js";

/** Create and connect an IMAP client */
export async function createImapClient(creds: Credentials): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: creds.imapHost,
    port: creds.imapPort,
    secure: creds.imapPort === 993,
    auth: {
      user: creds.user,
      pass: creds.password,
    },
    logger: false,
  });

  await client.connect();
  console.error(`[IMAP] Connected to ${creds.imapHost} as ${creds.user}`);
  return client;
}
