import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestApp, standardFakeImap, type TestApp } from "../../__tests__/helpers/test-app.js";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as listFolders from "../list-folders.js";
import * as searchEmails from "../search-emails.js";
import * as readEmail from "../read-email.js";
import * as moveEmail from "../move-email.js";
import * as getEmailCount from "../get-email-count.js";
import * as getThread from "../get-thread.js";
import * as organizeByFilter from "../organize-by-filter.js";
import * as deleteEmail from "../delete-email.js";
import * as markAsRead from "../mark-as-read.js";
import * as flagEmail from "../flag-email.js";
import * as downloadAttachment from "../download-attachment.js";
import * as saveAttachment from "../save-attachment.js";
import * as summarizeSenders from "../summarize-senders.js";
import * as replyDraft from "../reply-draft.js";
import * as forwardDraft from "../forward-draft.js";
import * as manageFolders from "../manage-folders.js";

const ALL_FOLDER_TOOLS = [
  listFolders.register,
  getEmailCount.register,
  searchEmails.register,
  readEmail.register,
  getThread.register,
  moveEmail.register,
  organizeByFilter.register,
  deleteEmail.register,
  markAsRead.register,
  flagEmail.register,
  downloadAttachment.register,
  saveAttachment.register,
  summarizeSenders.register,
  replyDraft.register,
  forwardDraft.register,
  manageFolders.registerCreate,
  manageFolders.registerRename,
  manageFolders.registerDelete,
];

const NDA_MESSAGE_ID = "<vertrag-1@partner.example>";
const DENIED = /is locked in this mailbox's settings\. Nothing was changed\./;

/** Every folder with its messages' UIDs and flags: what any change to the mailbox would show up in. */
function snapshot(imap: FakeImap) {
  return [...imap.folders.values()]
    .map((f) => ({ path: f.path, messages: f.messages.map((m) => ({ uid: m.uid, flags: [...m.flags].sort() })) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

describe.each([
  ["at the top level", ""],
  ['below the "INBOX." namespace prefix', "INBOX/"],
])("a locked folder %s, with everything below it", (_label, prefix) => {
  const nda = `${prefix}_NDA_Inbox`;
  const sub = `${prefix}_NDA_Inbox/Projekt`;
  let t: TestApp;
  let h: Harness;
  let imap: FakeImap;
  let downloadDir: string;

  beforeEach(async () => {
    if (prefix) {
      imap = new FakeImap();
      imap.namespace = { prefix, delimiter: "/" };
      imap.addFolder(`${prefix}Drafts`, { specialUse: "\\Drafts" });
      imap.addFolder(`${prefix}Sent`, { specialUse: "\\Sent" });
      imap.addFolder(`${prefix}Trash`, { specialUse: "\\Trash" });
    } else {
      imap = standardFakeImap();
    }
    for (const folder of [nda, sub, `${prefix}_NDA_Inbox/Leer`, `${prefix}Archiv`]) imap.addFolder(folder);
    const attachments = [{ filename: "vertrag.txt", content: "Vertragsentwurf", contentType: "text/plain" }];
    imap.addMessage(nda, await buildRaw({
      from: "partner@partner.example", to: "max@firma.example", subject: "Vertrag Phoenix",
      text: "streng vertraulich", messageId: NDA_MESSAGE_ID, attachments,
    }));
    imap.addMessage(sub, await buildRaw({
      from: "partner@partner.example", to: "max@firma.example", subject: "Projektplan Phoenix",
      text: "ebenfalls vertraulich", attachments,
    }));
    imap.addMessage("INBOX", await buildRaw({
      from: "partner@partner.example", to: "max@firma.example", subject: "Re: Vertrag",
      text: "Haben Sie den Entwurf erhalten?", inReplyTo: NDA_MESSAGE_ID, references: [NDA_MESSAGE_ID],
    }));
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-lock-"));
    t = createTestApp([{ imap, policy: { folders: { deny: ["_NDA_Inbox"] } } }], { files: { downloadDir } });
    h = await t.connect(...ALL_FOLDER_TOOLS);
  });

  afterEach(async () => {
    await h.close();
    fs.rmSync(downloadDir, { recursive: true, force: true });
  });

  /** No IMAP command ever named the locked folder or one below it. */
  function expectNeverReached() {
    expect(JSON.stringify(imap.calls)).not.toContain("_NDA_Inbox");
  }

  it("keeps the folder and its subfolders out of list_folders and get_email_count", async () => {
    const list = await h.call("list_folders");
    expect(list.isError).toBe(false);
    expect(list.json.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(["INBOX", `${prefix}Archiv`]));
    expect(list.text).not.toContain("_NDA_Inbox");
    const counts = await h.call("get_email_count");
    expect(counts.isError).toBe(false);
    expect(counts.text).toContain(`${prefix}Archiv`);
    expect(counts.text).not.toContain("_NDA_Inbox");
    expectNeverReached();
  });

  it("does not pull the locked original into the conversation of a reply in INBOX", async () => {
    const res = await h.call("get_thread", { folder: "INBOX", uid: 1 });
    expect(res.isError).toBe(false);
    expect(res.json.messages.map((m: { folder: string }) => m.folder)).toEqual(["INBOX"]);
    expect(res.text).not.toMatch(/streng vertraulich|Vertrag Phoenix/);
    expectNeverReached();
  });

  const lockedNames = () => [nda, sub, "_NDA_Inbox", "Projekt"];

  it.each([
    ["get_email_count", "as the folder", (folder: string) => ({ folder })],
    ["search_emails", "as the folder", (folder: string) => ({ folder })],
    ["read_email", "as the folder", (folder: string) => ({ folder, uid: 1 })],
    ["get_thread", "as the folder", (folder: string) => ({ folder, uid: 1 })],
    ["get_thread", "as an extra folder", (folder: string) => ({ folder: "INBOX", uid: 1, extraFolders: [folder] })],
    ["summarize_senders", "as the folder", (folder: string) => ({ folder })],
    ["download_attachment", "as the folder", (folder: string) => ({ folder, uid: 1, attachmentIndex: 0 })],
    ["save_attachment", "as the folder", (folder: string) => ({ folder, uid: 1, attachmentIndex: 0 })],
    ["mark_as_read", "as the folder", (folder: string) => ({ folder, uids: [1] })],
    ["flag_email", "as the folder", (folder: string) => ({ folder, uids: [1], action: "add", flags: ["\\Flagged"] })],
    ["move_email", "as the source", (folder: string) => ({ folder, uids: [1], destination: "Archiv" })],
    ["move_email", "as the destination", (folder: string) => ({ folder: "INBOX", uids: [1], destination: folder })],
    ["organize_by_filter", "as the source", (folder: string) => ({ folder, filter: { all: true }, action: { type: "markRead" } })],
    ["organize_by_filter", "as the destination", (folder: string) => ({ filter: { all: true }, action: { type: "move", destination: folder } })],
    ["delete_email", "by UID", (folder: string) => ({ folder, uids: [1] })],
    ["delete_email", "by filter", (folder: string) => ({ folder, filter: { all: true } })],
    ["reply_draft", "as the original's folder", (folder: string) => ({ folder, uid: 1, body: "Danke" })],
    ["forward_draft", "as the original's folder", (folder: string) => ({ folder, uid: 1, to: "kollege@firma.example" })],
    ["rename_folder", "as the folder to rename", (folder: string) => ({ path: folder, newPath: "Offen" })],
    ["delete_folder", "as the folder to delete", (folder: string) => ({ path: folder })],
  ] as const)("refuses %s with it %s, says that nothing was changed, and changes nothing", async (tool, _role, args) => {
    const before = snapshot(imap);
    for (const name of lockedNames()) {
      const res = await h.call(tool, args(name));
      expect(res.isError, `${tool} ${name}`).toBe(true);
      expect(res.text, `${tool} ${name}`).toMatch(DENIED);
    }
    expect(snapshot(imap)).toEqual(before);
    expect(fs.readdirSync(downloadDir)).toEqual([]);
    expectNeverReached();
  });

  it("refuses delete_folder on an empty locked subfolder", async () => {
    const res = await h.call("delete_folder", { path: `${prefix}_NDA_Inbox/Leer` });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(DENIED);
    expect(imap.folders.has(`${prefix}_NDA_Inbox/Leer`)).toBe(true);
    expectNeverReached();
  });

  it.each([
    ["create_folder", { path: "_NDA_Inbox/Neu" }],
    ["create_folder", { path: "_NDA_Inbox" }],
    ["rename_folder", { path: "Archiv", newPath: "_NDA_Inbox/Archiv" }],
    ["rename_folder", { path: "Archiv", newPath: "_NDA_Inbox" }],
  ] as const)("refuses %s %j into it and changes nothing", async (tool, args) => {
    const before = snapshot(imap);
    const res = await h.call(tool, args);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(DENIED);
    expect(snapshot(imap)).toEqual(before);
    expectNeverReached();
  });

  it("still works on the visible folders next to it", async () => {
    expect((await h.call("search_emails", { folder: "Archiv" })).isError).toBe(false);
    const created = await h.call("create_folder", { path: "Archiv/2026" });
    expect(created.isError).toBe(false);
    expect(imap.folders.has(`${prefix}Archiv/2026`)).toBe(true);
    expect((await h.call("move_email", { uids: [1], destination: "Archiv" })).isError).toBe(false);
    expect(imap.uidsIn(`${prefix}Archiv`)).toEqual([1]);
    expectNeverReached();
  });
});

describe("a locked folder on Gmail", () => {
  it("keeps its messages out of a conversation even though All Mail holds them", async () => {
    const imap = new FakeImap();
    imap.capabilities.set("X-GM-EXT-1", true);
    imap.addFolder("_NDA_Inbox");
    imap.addFolder("[Gmail]/All Mail", { specialUse: "\\All", flags: ["\\HasNoChildren", "\\All"] });
    imap.addFolder("[Gmail]/Sent Mail", { specialUse: "\\Sent" });
    const original = await buildRaw({ from: "partner@partner.example", to: "max@firma.example", subject: "Vertrag Phoenix", text: "streng vertraulich", messageId: NDA_MESSAGE_ID });
    const reply = await buildRaw({ from: "partner@partner.example", to: "max@firma.example", subject: "Re: Vertrag", text: "Erhalten?", inReplyTo: NDA_MESSAGE_ID, references: [NDA_MESSAGE_ID] });
    imap.addMessage("_NDA_Inbox", original, { threadId: "t1" });
    imap.addMessage("INBOX", reply, { threadId: "t1" });
    imap.addMessage("[Gmail]/All Mail", original, { threadId: "t1" });
    imap.addMessage("[Gmail]/All Mail", reply, { threadId: "t1" });
    const t = createTestApp([{ imap, policy: { folders: { deny: ["_NDA_Inbox"] } } }]);
    const h = await t.connect(getThread.register);
    const res = await h.call("get_thread", { uid: 1 });
    expect(res.isError).toBe(false);
    expect(res.json.messages.map((m: { folder: string }) => m.folder)).toEqual(["INBOX"]);
    expect(res.text).not.toContain("streng vertraulich");
    expect(JSON.stringify(imap.calls)).not.toMatch(/_NDA_Inbox|All Mail/);
    await h.close();
  });
});

describe("folder scope in tools", () => {
  let t: TestApp;
  let h: Harness;

  beforeEach(async () => {
    t = createTestApp([{ policy: { folders: { deny: ["**/HR/**"] } } }]);
    const imap = t.imap();
    imap.addFolder("INBOX/HR");
    imap.addMessage("INBOX/HR", await buildRaw({ from: "hr@example.com", to: "max@firma.example", subject: "Gehalt", text: "vertraulich" }));
    imap.addMessage("INBOX", await buildRaw({ from: "kunde@example.com", to: "max@firma.example", subject: "Anfrage", text: "Hallo" }));
    h = await t.connect(
      listFolders.register,
      searchEmails.register,
      readEmail.register,
      moveEmail.register,
      getEmailCount.register,
      getThread.register,
    );
  });

  afterEach(async () => {
    await h.close();
  });

  it("hides denied folders from list_folders and get_email_count", async () => {
    const list = await h.call("list_folders");
    expect(list.isError).toBe(false);
    expect(list.text).not.toContain("INBOX/HR");
    const counts = await h.call("get_email_count");
    expect(counts.isError).toBe(false);
    expect(counts.text).not.toContain("INBOX/HR");
  });

  it("leaves Gmail's All Mail, Starred and Important out of list_folders while a folder is denied", async () => {
    const imap = t.imap();
    imap.addFolder("[Gmail]/All Mail", { specialUse: "\\All", flags: ["\\HasNoChildren", "\\All"] });
    imap.addFolder("[Gmail]/Important", { flags: ["\\HasNoChildren", "\\Important"] });
    imap.addFolder("[Gmail]/Starred", { specialUse: "\\Flagged", flags: ["\\HasNoChildren", "\\Flagged"] });
    const paths: string[] = (await h.call("list_folders")).json.map((f: { path: string }) => f.path);
    expect(paths).toContain("INBOX");
    expect(paths.filter((p) => p.startsWith("[Gmail]"))).toEqual([]);
  });

  it.each(["INBOX/HR", "inbox/hr", "INBOX.HR", "HR"])("refuses search_emails in %s", async (folder) => {
    const res = await h.call("search_emails", { folder });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/is locked in this mailbox's settings/);
  });

  it("refuses read_email and get_email_count in a denied folder", async () => {
    expect((await h.call("read_email", { folder: "HR", uid: 1 })).isError).toBe(true);
    expect((await h.call("get_email_count", { folder: "INBOX/HR" })).isError).toBe(true);
  });

  it("refuses get_thread in a denied folder or across one", async () => {
    expect((await h.call("get_thread", { folder: "INBOX/HR", uid: 1 })).isError).toBe(true);
    const across = await h.call("get_thread", { uid: 1, extraFolders: ["HR"] });
    expect(across.isError).toBe(true);
    expect(across.text).toMatch(/is locked in this mailbox's settings/);
  });

  it("refuses moving mail into a denied folder", async () => {
    const res = await h.call("move_email", { uids: [1], destination: "INBOX/HR" });
    expect(res.isError).toBe(true);
    expect(t.imap().uidsIn("INBOX")).toEqual([1]);
  });
});
