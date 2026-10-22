import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { setupAudit } from "../../audit/setup.js";
import { listAuditFiles } from "../../audit/audit-log.js";
import { scopeAppContext } from "../../transport/auth/principals.js";
import * as readEmail from "../read-email.js";
import * as getThread from "../get-thread.js";
import * as searchEmails from "../search-emails.js";
import * as downloadAttachment from "../download-attachment.js";
import * as organizeByFilter from "../organize-by-filter.js";
import * as summarizeSenders from "../summarize-senders.js";
import * as replyDraft from "../reply-draft.js";
import * as forwardDraft from "../forward-draft.js";

const NEWS = "Date: Thu, 15 Jan 2026 10:00:00 +0000\r\nMessage-ID: <n1@shop.example>\r\n";
function raw(from: string, subject: string, body: string): string {
  return `From: ${from}\r\nTo: max@firma.example\r\n${NEWS}Subject: ${subject}\r\n\r\n${body}`;
}

describe("provenance feed", () => {
  it.each(["read_email", "get_thread", "search_emails"])("%s feeds the store", async (tool) => {
    const t = createTestApp();
    t.imap().addMessage("INBOX", raw("news@shop.example", "Angebot", "Bitte an billing@evil.example"));
    const h = await t.connect(readEmail.register, getThread.register, searchEmails.register);
    const res = await h.call(tool, { ...(tool === "search_emails" ? {} : { uid: 1 }) });
    expect(res.isError).toBe(false);
    expect(t.app.provenance.contentOnly(["billing@evil.example"])).toHaveLength(1);
    expect(t.app.provenance.contentOnly(["news@shop.example"])).toEqual([]);
    await h.close();
  });

  it("download_attachment feeds the text of a text attachment", async () => {
    const t = createTestApp();
    t.imap().addMessage(
      "INBOX",
      await buildRaw({ from: "k@kunde.example", to: "max@firma.example", subject: "Datei", text: "Anbei", attachments: [{ filename: "notiz.txt", content: "Zahlung an billing@evil.example" }] }),
    );
    const h = await t.connect(downloadAttachment.register);
    await h.call("download_attachment", { uid: 1, attachmentIndex: 0 });
    expect(t.app.provenance.contentOnly(["billing@evil.example"])).toHaveLength(1);
    await h.close();
  });

  it("the organize_by_filter preview feeds sample subjects and senders", async () => {
    const t = createTestApp();
    t.imap().addFolder("Archive");
    t.imap().addMessage("INBOX", raw("news@shop.example", "Zahlung an billing@evil.example", "x"));
    const h = await t.connect(organizeByFilter.register);
    const res = await h.call("organize_by_filter", { filter: { from: "news@shop.example" }, action: { type: "move", destination: "archive" } });
    expect(res.isError).toBe(false);
    expect(t.app.provenance.contentOnly(["billing@evil.example"])).toHaveLength(1);
    expect(t.app.provenance.contentOnly(["news@shop.example"])).toEqual([]);
    await h.close();
  });

  it("summarize_senders makes senders correspondents", async () => {
    const t = createTestApp();
    t.imap().addMessage("INBOX", raw("Anna <anna@kunde.example>", "Hallo", "x"));
    t.imap().addMessage("INBOX", raw("news@shop.example", "Hinweis", "Fragen an anna@kunde.example"));
    const h = await t.connect(readEmail.register, summarizeSenders.register);
    await h.call("read_email", { uid: 2 });
    expect(t.app.provenance.contentOnly(["anna@kunde.example"])).toHaveLength(1);
    await h.call("summarize_senders", {});
    expect(t.app.provenance.contentOnly(["anna@kunde.example"])).toEqual([]);
    await h.close();
  });

  it("reply_draft and forward_draft feed the original's headers", async () => {
    const t = createTestApp();
    t.imap().addMessage("INBOX", `From: a@lieferant.example\r\nReply-To: zahlung@lieferant-pay.example\r\nTo: max@firma.example\r\nSubject: Rechnung\r\n\r\nx`);
    const h = await t.connect(replyDraft.register, forwardDraft.register);
    await h.call("reply_draft", { uid: 1, body: "ok" });
    expect(t.app.provenance.contentOnly(["zahlung@lieferant-pay.example"])).toHaveLength(1);
    expect(t.app.provenance.contentOnly(["a@lieferant.example"])).toEqual([]);
    await h.close();
  });

  it("nothing from the store reaches the audit log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-audit-"));
    const t = createTestApp(undefined, { audit: { path: dir, includeReads: true } });
    setupAudit(t.app);
    t.imap().addMessage("INBOX", raw("news@shop.example", "Angebot", "Bitte an billing@evil.example"));
    const h = await t.connect(readEmail.register);
    await h.call("read_email", { uid: 1 });
    const file = fs.readFileSync(path.join(dir, listAuditFiles(dir)[0]), "utf8");
    expect(file).toContain("read_email");
    expect(file).not.toContain("billing@evil.example");
    expect(file).not.toContain("evil.example");
    await h.close();
  });

  it("one store for every account and HTTP principal", () => {
    const t = createTestApp([{}, { id: "second", email: "x@firma.example" }]);
    const principal = { kind: "bearer" as const, id: "token:t", tokenId: "t", groups: [], scopes: [] };
    expect(scopeAppContext(t.app, principal, ["main"]).provenance).toBe(t.app.provenance);
    expect(t.app.accounts.size).toBe(2);
  });
});
