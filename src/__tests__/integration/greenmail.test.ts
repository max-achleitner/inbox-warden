/**
 * End-to-end tests against a real IMAP/SMTP server (GreenMail in Docker).
 *   docker compose -f test/docker-compose.greenmail.yml up -d
 *   IMAP_IT_HOST=localhost npm run test:integration
 * Skipped when IMAP_IT_HOST is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { connectHarness, type Harness } from "../helpers/mcp-harness.js";
import { header } from "../helpers/messages.js";
import { ConfigSchema } from "../../config/schema.js";
import { createAppContext } from "../../context.js";
import * as searchEmails from "../../tools/search-emails.js";
import * as moveEmail from "../../tools/move-email.js";
import * as createDraft from "../../tools/create-draft.js";
import * as sendEmail from "../../tools/send-email.js";
import { GREENMAIL_HOST as HOST, connectGreenMail as connect, sleep } from "./greenmail-client.js";

async function waitForMessages(client: ImapFlow, folder: string, count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const status = await client.status(folder, { messages: true });
    if (status && (status.messages ?? 0) >= count) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${count} messages in ${folder}`);
}

describe.skipIf(!HOST)("GreenMail integration", () => {
  const user = `it-${Date.now()}@example.com`;
  const smtp = nodemailer.createTransport({ host: HOST, port: 3025, secure: false, ignoreTLS: true });
  let client: ImapFlow;
  let h: Harness;

  beforeAll(async () => {
    client = await connect(user);
    for (const folder of ["Archive", "Drafts", "Sent"]) await client.mailboxCreate(folder);
    await smtp.sendMail({ from: "anna@example.com", to: user, subject: "Seed A", text: "a" });
    await smtp.sendMail({ from: "bob@example.com", to: user, subject: "Seed B", text: "b" });
    await waitForMessages(client, "INBOX", 2);

    const config = ConfigSchema.parse({
      version: 2,
      accounts: [{
        id: "main",
        email: user,
        imap: { host: HOST, port: 3143 },
        smtp: { host: HOST, port: 3025 },
        permissions: { read: true, write: true, send: true, delete: true },
      }],
    });
    const secrets = { get: async () => "secret", set: async () => {}, delete: async () => {} };
    const app = createAppContext(config, secrets, {
      connectImap: () => async () => client,
      createTransport: () => smtp,
      sentProbe: { attempts: 1, delayMs: 0 },
    });
    h = await connectHarness((server) => {
      for (const register of [searchEmails.register, moveEmail.register, createDraft.register, sendEmail.register]) {
        register(server, app);
      }
    });
  });

  afterAll(async () => {
    await h?.close();
    await client?.logout();
  });

  it("search_emails applies the sender filter on a real server", async () => {
    const res = await h.call("search_emails", { from: "anna@example.com" });
    expect(res.isError).toBe(false);
    expect(res.json.totalMatches).toBe(1);
    expect(res.json.messages[0].subject).toBe("Seed A");
  });

  it("move_email to a missing folder fails and leaves the inbox untouched", async () => {
    const search = await h.call("search_emails", {});
    const uids = search.json.messages.map((m: any) => m.uid);
    const res = await h.call("move_email", { uids, destination: "Does/Not/Exist" });
    expect(res.isError).toBe(true);
    const after = await h.call("search_emails", {});
    expect(after.json.totalMatches).toBe(uids.length);
  });

  it("create_draft round-trips an umlaut attachment filename through the server", async () => {
    const res = await h.call("create_draft", {
      to: "kunde@example.com",
      subject: "Größe",
      body: "Anbei.",
      attachments: [{ filename: "Angebot_Größe.pdf", content: Buffer.from("%PDF").toString("base64"), contentType: "application/pdf" }],
    });
    expect(res.isError).toBe(false);
    const lock = await client.getMailboxLock("Drafts");
    try {
      const msg = await client.fetchOne(String(res.json.uid), { source: true }, { uid: true });
      const parsed = await simpleParser(msg && msg.source ? msg.source : Buffer.alloc(0));
      expect(parsed.subject).toBe("Größe");
      expect(parsed.attachments[0].filename).toBe("Angebot_Größe.pdf");
    } finally {
      lock.release();
    }
  });

  it("send_email delivers without Bcc header and files a copy in Sent", async () => {
    const res = await h.call("send_email", { to: user, bcc: "hidden@example.com", subject: "Self test", body: "hi" });
    expect(res.isError).toBe(false);
    expect(res.json.sentCopy.saved).toBe(true);
    await waitForMessages(client, "INBOX", 3);
    const lock = await client.getMailboxLock("INBOX");
    try {
      const [uid] = (await client.search({ subject: "Self test" }, { uid: true })) || [];
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      expect(header(msg && msg.source ? msg.source : Buffer.alloc(0), "bcc")).toBeUndefined();
    } finally {
      lock.release();
    }
  });
});
