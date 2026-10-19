import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../../context.js";
import { createTestApp, gmailFakeImap, standardFakeImap, type TestApp } from "../../__tests__/helpers/test-app.js";
import type { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as searchEmails from "../search-emails.js";
import * as readEmail from "../read-email.js";
import * as getThread from "../get-thread.js";
import * as getEmailCount from "../get-email-count.js";
import * as summarizeSenders from "../summarize-senders.js";
import * as downloadAttachment from "../download-attachment.js";
import * as saveAttachment from "../save-attachment.js";
import * as markAsRead from "../mark-as-read.js";
import * as flagEmail from "../flag-email.js";
import * as moveEmail from "../move-email.js";
import * as organizeByFilter from "../organize-by-filter.js";
import * as deleteEmail from "../delete-email.js";
import * as replyDraft from "../reply-draft.js";
import * as forwardDraft from "../forward-draft.js";
import * as sendDraft from "../send-draft.js";
import * as manageFolders from "../manage-folders.js";
import * as listFolders from "../list-folders.js";

const MESSAGE_TOOLS: Array<(server: McpServer, app: AppContext) => void> = [
  listFolders.register,
  searchEmails.register,
  readEmail.register,
  getThread.register,
  getEmailCount.register,
  summarizeSenders.register,
  downloadAttachment.register,
  saveAttachment.register,
  markAsRead.register,
  flagEmail.register,
  moveEmail.register,
  organizeByFilter.register,
  deleteEmail.register,
  replyDraft.register,
  forwardDraft.register,
  sendDraft.register,
  manageFolders.registerRename,
  manageFolders.registerDelete,
];

const ME = "max@firma.example";
const NDA_MESSAGE_ID = "<vertrag-1@partner.example>";
const SENT = "[Gmail]/Sent Mail";
/** Anything of the hidden messages: subjects, bodies, attachment, sender. */
const SECRET = /Phoenix|vertraulich|geheim|unterschreiben|vertrag\.txt|Vertragsentwurf|partner@partner\.example/;
const DENIED = /blocked by your administrator's policy|because of your administrator's folder policy/;

/** Every folder with its messages' UIDs, flags and labels: what any change to the mailbox would show up in. */
function snapshot(imap: FakeImap) {
  return [...imap.folders.values()]
    .map((f) => ({
      path: f.path,
      messages: f.messages.map((m) => ({ uid: m.uid, flags: [...m.flags].sort(), labels: [...(m.labels ?? [])].sort() })),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function labelFetches(imap: FakeImap) {
  return imap.calls.filter((c) => c.method === "fetch" && (c.args[1] as { labels?: boolean }).labels);
}

/**
 * A Gmail mailbox where "_NDA_Inbox" is locked: NDA mail that also carries "Kunden", sits in
 * INBOX, is a reply in Sent, or carries the nested label "_NDA_Inbox/Projekt" — next to ordinary
 * mail in the same folders.
 */
async function gmailMailbox() {
  const imap = gmailFakeImap(["_NDA_Inbox", "_NDA_Inbox/Projekt", "Kunden", "Archiv", "Nur-NDA"]);
  const attachments = [{ filename: "vertrag.txt", content: "Vertragsentwurf", contentType: "text/plain" }];
  const partner = "partner@partner.example";
  const hidden = {
    kunden: imap.addGmailMessage(
      await buildRaw({ from: partner, to: ME, subject: "Vertrag Phoenix", text: "streng vertraulich", messageId: NDA_MESSAGE_ID, attachments }),
      ["_NDA_Inbox", "Kunden"],
    ),
    inbox: imap.addGmailMessage(
      await buildRaw({ from: partner, to: ME, subject: "Phoenix Term Sheet", text: "geheim", attachments }),
      ["\\Inbox", "_NDA_Inbox", "\\Important"],
    ),
    sent: imap.addGmailMessage(
      await buildRaw({ from: ME, to: partner, subject: "Re: Vertrag Phoenix", text: "Wir unterschreiben", inReplyTo: NDA_MESSAGE_ID, references: [NDA_MESSAGE_ID] }),
      ["\\Sent", "_NDA_Inbox"],
      { flags: ["\\Seen"] },
    ),
    nested: imap.addGmailMessage(
      await buildRaw({ from: partner, to: ME, subject: "Phoenix Projektplan", text: "ebenfalls vertraulich", attachments }),
      ["Kunden", "_NDA_Inbox/Projekt"],
    ),
    only: imap.addGmailMessage(await buildRaw({ from: partner, to: ME, subject: "Phoenix intern", text: "geheim" }), ["Nur-NDA", "_NDA_Inbox"]),
  };
  const visible = {
    kunden: imap.addGmailMessage(
      await buildRaw({ from: "kunde@example.com", to: ME, subject: "Angebot", text: "Bitte um ein Angebot", messageId: "<angebot-1@example.com>" }),
      ["Kunden"],
    ),
    inbox: imap.addGmailMessage(
      await buildRaw({ from: "kunde@example.com", to: ME, subject: "Re: Vertrag", text: "Haben Sie den Entwurf erhalten?", inReplyTo: NDA_MESSAGE_ID, references: [NDA_MESSAGE_ID] }),
      ["\\Inbox"],
    ),
    sent: imap.addGmailMessage(
      await buildRaw({ from: ME, to: "kunde@example.com", subject: "Re: Angebot", text: "Gerne", inReplyTo: "<angebot-1@example.com>" }),
      ["\\Sent"],
      { flags: ["\\Seen"] },
    ),
  };
  return { imap, hidden, visible };
}

describe("Gmail label lock: a message with a hidden label does not exist in any folder", () => {
  let t: TestApp;
  let h: Harness;
  let imap: FakeImap;
  let hidden: Awaited<ReturnType<typeof gmailMailbox>>["hidden"];
  let visible: Awaited<ReturnType<typeof gmailMailbox>>["visible"];
  let downloadDir: string;

  /** Where the hidden messages show up, besides "_NDA_Inbox" itself. */
  const hiddenPlaces = () => [
    ["Kunden", hidden.kunden.get("Kunden")!],
    ["Kunden", hidden.nested.get("Kunden")!],
    ["INBOX", hidden.inbox.get("INBOX")!],
    [SENT, hidden.sent.get(SENT)!],
  ] as const;

  beforeEach(async () => {
    ({ imap, hidden, visible } = await gmailMailbox());
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-labels-"));
    t = createTestApp([{ imap, policy: { folders: { deny: ["_NDA_Inbox"] } } }], { files: { downloadDir } });
    h = await t.connect(...MESSAGE_TOOLS);
  });

  afterEach(async () => {
    await h.close();
    fs.rmSync(downloadDir, { recursive: true, force: true });
  });

  /** No IMAP command ever named the locked label or one below it. */
  function expectLockedLabelNeverReached() {
    expect(JSON.stringify(imap.calls)).not.toContain("_NDA_Inbox");
  }

  it("search_emails lists only the visible messages of Kunden, INBOX and Sent, and counts only those", async () => {
    for (const [folder, uid] of [["Kunden", visible.kunden.get("Kunden")], ["INBOX", visible.inbox.get("INBOX")], [SENT, visible.sent.get(SENT)]] as const) {
      const res = await h.call("search_emails", { folder });
      expect(res.isError, folder).toBe(false);
      expect(res.json.messages.map((m: { uid: number }) => m.uid), folder).toEqual([uid]);
      expect(res.json.totalMatches, folder).toBe(1);
      expect(res.text, folder).not.toMatch(SECRET);
    }
    for (const filter of [{ subject: "Phoenix" }, { gmailQuery: "Phoenix" }, { from: "partner@partner.example" }, { hasAttachment: true }]) {
      const res = await h.call("search_emails", { folder: "Kunden", ...filter });
      expect(res.isError, JSON.stringify(filter)).toBe(false);
      expect(res.json.totalMatches, JSON.stringify(filter)).toBe(0);
    }
    expectLockedLabelNeverReached();
  });

  it("summarize_senders counts only the senders of visible messages", async () => {
    const res = await h.call("summarize_senders", { folder: "Kunden" });
    expect(res.isError).toBe(false);
    expect(res.json.totalMatches).toBe(1);
    expect(res.json.senders.map((s: { sender: string }) => s.sender)).toEqual(["kunde@example.com"]);
    const byDomain = await h.call("summarize_senders", { folder: SENT, groupBy: "domain" });
    expect(byDomain.json.senders).toEqual([expect.objectContaining({ sender: "firma.example", count: 1 })]);
    expect(res.text + byDomain.text).not.toMatch(SECRET);
  });

  it("get_email_count counts only visible messages, for one folder and for all folders", async () => {
    expect((await h.call("get_email_count", { folder: "Kunden" })).json).toEqual({ folder: "Kunden", total: 1, unread: 1 });
    expect((await h.call("get_email_count", { folder: "INBOX" })).json).toEqual({ folder: "INBOX", total: 1, unread: 1 });
    expect((await h.call("get_email_count", { folder: "Nur-NDA" })).json).toEqual({ folder: "Nur-NDA", total: 0, unread: 0 });
    const all = await h.call("get_email_count");
    expect(all.isError).toBe(false);
    const byPath = Object.fromEntries(all.json.map((f: { path: string }) => [f.path, f]));
    expect(byPath.Kunden).toEqual({ path: "Kunden", total: 1, unread: 1 });
    expect(byPath.INBOX).toEqual({ path: "INBOX", total: 1, unread: 1 });
    expect(byPath[SENT]).toEqual({ path: SENT, total: 1, unread: 0 });
    expect(byPath["Nur-NDA"]).toEqual({ path: "Nur-NDA", total: 0, unread: 0 });
    expect(all.text).not.toMatch(/_NDA_Inbox|All Mail|Important|Starred/);
    expect(imap.callsTo("status")).toEqual([]);
    expectLockedLabelNeverReached();
  });

  it.each([
    ["read_email", (folder: string, uid: number) => ({ folder, uid })],
    ["get_thread", (folder: string, uid: number) => ({ folder, uid })],
    ["download_attachment", (folder: string, uid: number) => ({ folder, uid, attachmentIndex: 0 })],
    ["save_attachment", (folder: string, uid: number) => ({ folder, uid, attachmentIndex: 0 })],
    ["reply_draft", (folder: string, uid: number) => ({ folder, uid, body: "Danke" })],
    ["forward_draft", (folder: string, uid: number) => ({ folder, uid, to: "kollege@firma.example" })],
  ] as const)("%s answers a hidden message exactly like a UID that does not exist, and changes nothing", async (tool, args) => {
    const before = snapshot(imap);
    for (const [folder, uid] of hiddenPlaces()) {
      const res = await h.call(tool, args(folder, uid));
      const missing = await h.call(tool, args(folder, 999));
      expect(res.isError, `${tool} ${folder} ${uid}`).toBe(true);
      expect(res.text, `${tool} ${folder} ${uid}`).toBe(missing.text.replace("999", String(uid)));
      expect(JSON.stringify(res.content)).not.toMatch(SECRET);
    }
    expect(snapshot(imap)).toEqual(before);
    expect(fs.readdirSync(downloadDir)).toEqual([]);
    expectLockedLabelNeverReached();
  });

  it.each([
    ["mark_as_read", (folder: string, uids: number[]) => ({ folder, uids })],
    ["flag_email", (folder: string, uids: number[]) => ({ folder, uids, action: "add", flags: ["\\Flagged"] })],
    ["move_email", (folder: string, uids: number[]) => ({ folder, uids, destination: "Archiv" })],
    ["delete_email", (folder: string, uids: number[]) => ({ folder, uids })],
  ] as const)("%s answers hidden UIDs exactly like missing ones and changes nothing", async (tool, args) => {
    const before = snapshot(imap);
    for (const [folder, uid] of hiddenPlaces()) {
      const res = await h.call(tool, args(folder, [uid]));
      const missing = await h.call(tool, args(folder, [999]));
      expect(res.isError, `${tool} ${folder} ${uid}`).toBe(true);
      expect(res.text, `${tool} ${folder} ${uid}`).toBe(missing.text);
    }
    expect(snapshot(imap)).toEqual(before);
    expectLockedLabelNeverReached();
  });

  it("acts only on the visible message of a mixed UID list and reports the hidden one as missing", async () => {
    const nda = hidden.kunden.get("Kunden")!;
    const ok = visible.kunden.get("Kunden")!;
    const res = await h.call("mark_as_read", { folder: "Kunden", uids: [nda, ok] });
    expect(res.isError).toBe(false);
    expect(res.json.uids).toEqual([ok]);
    expect(res.json.missingUids).toEqual([nda]);
    expect(imap.message("Kunden", ok)!.flags.has("\\Seen")).toBe(true);
    expect(imap.message("Kunden", nda)!.flags.has("\\Seen")).toBe(false);
    const moved = await h.call("move_email", { folder: "Kunden", uids: [nda, ok], destination: "Archiv" });
    expect(moved.json.uids).toEqual([ok]);
    expect(imap.uidsIn("Kunden")).toEqual([nda, hidden.nested.get("Kunden")!]);
  });

  it("organize_by_filter previews and changes only the visible messages", async () => {
    const preview = await h.call("organize_by_filter", { folder: "Kunden", filter: { all: true }, action: { type: "markRead" } });
    expect(preview.isError).toBe(false);
    expect(preview.json.count).toBe(1);
    expect(preview.json.sample.map((s: { uid: number }) => s.uid)).toEqual([visible.kunden.get("Kunden")]);
    expect(preview.json.topSenders.map((s: { sender: string }) => s.sender)).toEqual(["kunde@example.com"]);
    expect(preview.text).not.toMatch(SECRET);
    const commit = await h.call("organize_by_filter", {
      folder: "Kunden", filter: { all: true }, action: { type: "markRead" }, confirmToken: preview.json.confirmToken,
    });
    expect(commit.isError).toBe(false);
    expect(commit.json.count).toBe(1);
    expect(imap.message("Kunden", visible.kunden.get("Kunden")!)!.flags.has("\\Seen")).toBe(true);
    expect(imap.message("Kunden", hidden.kunden.get("Kunden")!)!.flags.has("\\Seen")).toBe(false);
    expect(imap.message("Kunden", hidden.nested.get("Kunden")!)!.flags.has("\\Seen")).toBe(false);
  });

  it("delete_email by filter previews and moves to Trash only the visible messages", async () => {
    const preview = await h.call("delete_email", { folder: "INBOX", filter: { all: true } });
    expect(preview.json.count).toBe(1);
    expect(preview.text).not.toMatch(SECRET);
    const commit = await h.call("delete_email", { folder: "INBOX", confirmToken: preview.json.confirmToken });
    expect(commit.isError).toBe(false);
    expect(imap.uidsIn("INBOX")).toEqual([hidden.inbox.get("INBOX")]);
    expect(imap.uidsIn("[Gmail]/Trash")).toHaveLength(1);
  });

  it("refuses a bulk commit when a previewed message got a hidden label after the preview", async () => {
    const preview = await h.call("organize_by_filter", { folder: "Kunden", filter: { all: true }, action: { type: "flag" } });
    expect(preview.json.count).toBe(1);
    imap.message("Kunden", visible.kunden.get("Kunden")!)!.labels!.add("_NDA_Inbox/Projekt");
    const before = snapshot(imap);
    const commit = await h.call("organize_by_filter", {
      folder: "Kunden", filter: { all: true }, action: { type: "flag" }, confirmToken: preview.json.confirmToken,
    });
    expect(commit.isError).toBe(true);
    expect(commit.text).toMatch(/no longer in "Kunden".*Nothing was changed/s);
    expect(snapshot(imap)).toEqual(before);
  });

  it("get_thread leaves hidden originals and replies out of a visible conversation", async () => {
    const res = await h.call("get_thread", { folder: "INBOX", uid: visible.inbox.get("INBOX")!, extraFolders: ["Kunden"] });
    expect(res.isError).toBe(false);
    expect(res.json.messages.map((m: { folder: string; uid: number }) => [m.folder, m.uid])).toEqual([["INBOX", visible.inbox.get("INBOX")]]);
    expect(res.json.threadSize).toBe(1);
    expect(res.text).not.toMatch(SECRET);
    expectLockedLabelNeverReached();
  });

  it("send_draft neither sends nor moves a draft carrying a hidden label", async () => {
    const draft = imap.addGmailMessage(
      await buildRaw({ from: ME, to: "partner@partner.example", subject: "Phoenix Entwurf", text: "geheim" }),
      ["\\Draft", "_NDA_Inbox"],
      { flags: ["\\Draft"] },
    );
    const uid = draft.get("[Gmail]/Drafts")!;
    const before = snapshot(imap);
    const res = await h.call("send_draft", { uid });
    const missing = await h.call("send_draft", { uid: 999 });
    expect(res.isError).toBe(true);
    expect(res.text).toBe(missing.text.replace("999", String(uid)));
    expect(t.capture().sent).toEqual([]);
    expect(snapshot(imap)).toEqual(before);
  });

  it("rename_folder refuses a label that hidden messages carry; delete_folder does not tell how many messages a folder holds", async () => {
    const before = snapshot(imap);
    for (const folder of ["Kunden", "Nur-NDA"]) {
      const renamed = await h.call("rename_folder", { path: folder, newPath: `${folder}-alt` });
      expect(renamed.isError, folder).toBe(true);
      expect(renamed.text, folder).toMatch(DENIED);
      const deleted = await h.call("delete_folder", { path: folder });
      expect(deleted.isError, folder).toBe(true);
      expect(deleted.text, folder).toMatch(/is not empty\. Move or delete its messages first\. Nothing was deleted\./);
      expect(deleted.text, folder).not.toMatch(/\d/);
    }
    expect(snapshot(imap)).toEqual(before);
    const renamed = await h.call("rename_folder", { path: "Archiv", newPath: "Ablage" });
    expect(renamed.isError).toBe(false);
    expect(imap.folders.has("Ablage")).toBe(true);
  });

  it.each(["false", "throw"] as const)("fails closed when the server answers without labels (%s) and changes nothing", async (mode) => {
    const before = snapshot(imap);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["search_emails", { folder: "Kunden" }],
      ["read_email", { folder: "Kunden", uid: visible.kunden.get("Kunden")! }],
      ["mark_as_read", { folder: "Kunden", uids: [visible.kunden.get("Kunden")!] }],
      ["move_email", { folder: "Kunden", uids: [visible.kunden.get("Kunden")!], destination: "Archiv" }],
      ["get_email_count", { folder: "Kunden" }],
      ["organize_by_filter", { folder: "Kunden", filter: { all: true }, action: { type: "markRead" } }],
    ];
    for (const [tool, args] of calls) {
      imap.failOn("labels", mode);
      const res = await h.call(tool, args);
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toMatch(/Gmail labels.*Nothing was changed/s);
      expect(res.text, tool).not.toMatch(SECRET);
    }
    expect(snapshot(imap)).toEqual(before);
  });
});

describe("Gmail label lock: which labels hide a message", () => {
  async function searchInbox(imap: FakeImap, folders: Record<string, unknown>) {
    const t = createTestApp([{ imap, policy: { folders } }]);
    const h = await t.connect(searchEmails.register);
    const res = await h.call("search_emails", { folder: "INBOX" });
    await h.close();
    expect(res.isError).toBe(false);
    return res.json.messages.map((m: { subject: string }) => m.subject);
  }

  it("hides a message by a system label whose special-use folder a deny pattern hides", async () => {
    const imap = gmailFakeImap();
    imap.addGmailMessage(await buildRaw({ from: ME, to: "a@example.com", subject: "Eigene Antwort", text: "x" }), ["\\Inbox", "\\Sent"]);
    imap.addGmailMessage(await buildRaw({ from: "b@example.com", to: ME, subject: "Frage", text: "x" }), ["\\Inbox"]);
    expect(await searchInbox(imap, { deny: ["[Gmail]/Sent Mail"] })).toEqual(["Frage"]);
  });

  it("never hides a message for its Important or Starred label", async () => {
    const imap = gmailFakeImap();
    imap.addGmailMessage(await buildRaw({ from: "b@example.com", to: ME, subject: "Wichtig", text: "x" }), ["\\Inbox", "\\Important", "\\Starred"]);
    expect(await searchInbox(imap, { deny: ["[Gmail]/Important", "[Gmail]/Starred"] })).toEqual(["Wichtig"]);
  });

  it("hides by deny patterns only: a label merely missing from the allow list hides nothing", async () => {
    const imap = gmailFakeImap(["Kunden", "Privat"]);
    imap.addGmailMessage(await buildRaw({ from: "b@example.com", to: ME, subject: "Gemischt", text: "x" }), ["\\Inbox", "Privat"]);
    expect(await searchInbox(imap, { allow: ["INBOX", "Kunden"] })).toEqual(["Gemischt"]);
    expect(await searchInbox(imap, { allow: ["INBOX", "Kunden"], deny: ["Archiv"] })).toEqual(["Gemischt"]);
    expect(await searchInbox(imap, { allow: ["INBOX", "Kunden"], deny: ["Privat"] })).toEqual([]);
  });

  it("hides a message by a nested label below a denied one, and by a bare name at any depth", async () => {
    const imap = gmailFakeImap(["Projekte", "Projekte/_NDA_Alpha", "_NDA_Inbox", "_NDA_Inbox/Projekt"]);
    imap.addGmailMessage(await buildRaw({ from: "b@example.com", to: ME, subject: "Tief", text: "x" }), ["\\Inbox", "Projekte/_NDA_Alpha"]);
    imap.addGmailMessage(await buildRaw({ from: "b@example.com", to: ME, subject: "Unten", text: "x" }), ["\\Inbox", "_NDA_Inbox/Projekt"]);
    imap.addGmailMessage(await buildRaw({ from: "b@example.com", to: ME, subject: "Offen", text: "x" }), ["\\Inbox", "Projekte"]);
    expect(await searchInbox(imap, { deny: ["_NDA_*"] })).toEqual(["Offen"]);
    expect(await searchInbox(imap, { deny: ["_NDA_Inbox"] })).toEqual(["Offen", "Tief"]);
  });
});

describe("Gmail label lock: cost", () => {
  async function exercise(t: TestApp) {
    const imap = t.imap();
    imap.addFolder("Kunden");
    const raw = await buildRaw({ from: "b@example.com", to: ME, subject: "Frage", text: "x" });
    imap.addMessage("INBOX", raw);
    const h = await t.connect(searchEmails.register, readEmail.register, markAsRead.register, getEmailCount.register);
    for (const [tool, args] of [
      ["search_emails", {}],
      ["read_email", { uid: 1 }],
      ["mark_as_read", { uids: [1] }],
      ["get_email_count", { folder: "INBOX" }],
    ] as const) {
      const listsBefore = imap.callsTo("list").length;
      expect((await h.call(tool, args)).isError, tool).toBe(false);
      expect(imap.callsTo("list").length - listsBefore, tool).toBe(1);
    }
    await h.close();
    return imap;
  }

  it("fetches no labels on a server without Gmail's extensions, even with deny rules", async () => {
    const imap = await exercise(createTestApp([{ imap: standardFakeImap(), policy: { folders: { deny: ["_NDA_Inbox"] } } }]));
    expect(labelFetches(imap)).toEqual([]);
    expect(imap.callsTo("status")).toHaveLength(1);
  });

  it("fetches no labels on Gmail without deny rules", async () => {
    const imap = await exercise(createTestApp([{ imap: gmailFakeImap(), policy: { folders: { allow: ["INBOX", "Kunden"] } } }]));
    expect(labelFetches(imap)).toEqual([]);
    expect(imap.callsTo("status")).toHaveLength(1);
  });

  it("reads a message's labels and source in one FETCH on Gmail with deny rules", async () => {
    const imap = await exercise(createTestApp([{ imap: gmailFakeImap(), policy: { folders: { deny: ["_NDA_Inbox"] } } }]));
    expect(imap.callsTo("download")).toEqual([]);
    expect(labelFetches(imap).some((c) => (c.args[1] as { source?: boolean }).source)).toBe(true);
  });
});
