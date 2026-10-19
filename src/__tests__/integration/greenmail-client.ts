import { ImapFlow } from "imapflow";

/** Host of the GreenMail test server; the integration tests are skipped when IMAP_IT_HOST is not set. */
export const GREENMAIL_HOST = process.env.IMAP_IT_HOST;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Log in to GreenMail as `user` (created on first login), retrying while the container starts. */
export async function connectGreenMail(user: string): Promise<ImapFlow> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    const client = new ImapFlow({
      host: GREENMAIL_HOST!,
      port: 3143,
      secure: false,
      doSTARTTLS: false, // throwaway local test server; no real credentials involved
      auth: { user, pass: "secret" },
      logger: false,
    });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      await sleep(1000);
    }
  }
  throw lastError;
}
