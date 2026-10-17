import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as moveEmail from "../../tools/move-email.js";
import * as sendEmail from "../../tools/send-email.js";
import { listAuditFiles, verifyAuditLog, type AuditRecord } from "../audit-log.js";
import { setupAudit } from "../setup.js";

function records(dir: string): AuditRecord[] {
  return fs
    .readFileSync(path.join(dir, listAuditFiles(dir)[0]), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditRecord);
}

describe("audit log end to end", () => {
  it("records mutating and outbound tool calls through the observer chain", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-audit-"));
    const t = createTestApp(undefined, { audit: { path: dir } });
    setupAudit(t.app);
    t.imap().addFolder("Archive");
    t.imap().addMessage("INBOX", "Subject: a\r\n\r\nx");
    const h = await t.connect(moveEmail.register, sendEmail.register);

    await h.call("move_email", { uids: [1], destination: "Archive" });
    await h.call("send_email", { to: "kunde@example.com", subject: "Angebot", body: "Geheimer Text" });

    expect(verifyAuditLog(dir)).toMatchObject({ ok: true, records: 2 });
    const [move, send] = records(dir);
    expect(move).toMatchObject({ account: "main", tool: "move_email", tier: "write", outcome: "success" });
    expect(move.details).toMatchObject({ folder: "INBOX", destination: "Archive", uids: [1] });
    expect(send).toMatchObject({ tool: "send_email", tier: "send", outcome: "success" });
    expect(send.details).toMatchObject({ recipients: ["kunde@example.com"], confirmation: "client-approval" });
    expect(JSON.stringify(send)).not.toContain("Geheimer Text");
    await h.close();
  });

  it("records policy denials", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-audit-"));
    const t = createTestApp([{ policy: { send: { mode: "direct", blockedRecipientDomains: ["example.com"] } } }], {
      audit: { path: dir },
    });
    setupAudit(t.app);
    const h = await t.connect(sendEmail.register);
    await h.call("send_email", { to: "kunde@example.com", subject: "x", body: "y" });
    expect(records(dir)[0]).toMatchObject({ tool: "send_email", outcome: "denied" });
    await h.close();
  });
});
