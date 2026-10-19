/**
 * A locked folder on a real IMAP server (GreenMail in Docker): with policy.folders.deny ["_NDA_Inbox"]
 * the folder and every folder below it stay out of reach of every tool, and no refusal changes anything.
 *   docker compose -f test/docker-compose.greenmail.yml up -d
 *   IMAP_IT_HOST=localhost npm run test:integration
 * Skipped when IMAP_IT_HOST is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImapFlow } from "imapflow";
import { connectHarness, type Harness } from "../helpers/mcp-harness.js";
import { buildRaw } from "../helpers/messages.js";
import { ConfigSchema } from "../../config/schema.js";
import { createAppContext } from "../../context.js";
import * as listFolders from "../../tools/list-folders.js";
import * as getEmailCount from "../../tools/get-email-count.js";
import * as searchEmails from "../../tools/search-emails.js";
import * as readEmail from "../../tools/read-email.js";
import * as getThread from "../../tools/get-thread.js";
import * as moveEmail from "../../tools/move-email.js";
import * as organizeByFilter from "../../tools/organize-by-filter.js";
import * as deleteEmail from "../../tools/delete-email.js";
import * as markAsRead from "../../tools/mark-as-read.js";
import * as flagEmail from "../../tools/flag-email.js";
import * as downloadAttachment from "../../tools/download-attachment.js";
import * as saveAttachment from "../../tools/save-attachment.js";
import * as summarizeSenders from "../../tools/summarize-senders.js";
import * as replyDraft from "../../tools/reply-draft.js";
import * as forwardDraft from "../../tools/forward-draft.js";
import * as manageFolders from "../../tools/manage-folders.js";
import { GREENMAIL_HOST as HOST, connectGreenMail } from "./greenmail-client.js";

const TOOLS = [
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

const DENIED = /blocked by your administrator's policy\. Nothing was changed\./;
const NDA_MESSAGE_ID = "<vertrag-it@partner.example>";

interface FolderState {
  path: string;
  messages: Array<{ uid: number; flags: string[] }>;
}

/** Every folder with its messages' UIDs and flags. \Recent is left out: the server clears it on SELECT. */
async function snapshot(client: ImapFlow): Promise<FolderState[]> {
  const state: FolderState[] = [];
  for (const folder of (await client.list()).sort((a, b) => a.path.localeCompare(b.path))) {
    const messages: FolderState["messages"] = [];
    if (!folder.flags.has("\\Noselect")) {
      const lock = await client.getMailboxLock(folder.path, { readOnly: true });
      try {
        if (client.mailbox && client.mailbox.exists > 0) {
          for await (const msg of client.fetch("1:*", { uid: true, flags: true })) {
            messages.push({ uid: msg.uid, flags: [...(msg.flags ?? [])].filter((f) => f !== "\\Recent").sort() });
          }
        }
      } finally {
        lock.release();
      }
    }
    state.push({ path: folder.path, messages: messages.sort((a, b) => a.uid - b.uid) });
  }
  return state;
}

async function onlyUid(client: ImapFlow, folder: string): Promise<number> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const uids = await client.search({ all: true }, { uid: true });
    if (!uids || uids.length !== 1) throw new Error(`Expected one message in ${folder}, found ${uids ? uids.length : "none"}`);
    return uids[0];
  } finally {
    lock.release();
  }
}

interface Target {
  folder: string;
  uid: number;
}

describe.skipIf(!HOST)("GreenMail: a locked folder and everything below it", () => {
  const user = `lock-${Date.now()}@example.com`;
  let client: ImapFlow;
  let h: Harness;
  let downloadDir: string;
  let stateDir: string;
  let delimiter: string;
  let nda: string;
  let sub: string;
  let empty: string;
  let archive: string;
  let ndaUid: number;
  let subUid: number;
  let replyUid: number;

  beforeAll(async () => {
    client = await connectGreenMail(user);
    delimiter =
      client.namespace?.delimiter ?? (await client.list()).find((f) => f.path.toUpperCase() === "INBOX")?.delimiter ?? ".";
    for (const name of ["Archiv", "Drafts", "Sent", "Trash", "_NDA_Inbox", `_NDA_Inbox${delimiter}Projekt`, `_NDA_Inbox${delimiter}Leer`]) {
      await client.mailboxCreate(name);
    }
    const listed = await client.list();
    const pathOf = (name: string) => {
      const found = listed.find((f) => f.name === name);
      if (!found) throw new Error(`GreenMail did not list the folder ${name}`);
      return found.path;
    };
    nda = pathOf("_NDA_Inbox");
    sub = pathOf("Projekt");
    empty = pathOf("Leer");
    archive = pathOf("Archiv");
    expect(sub).toBe(`${nda}${delimiter}Projekt`);

    const attachments = [{ filename: "vertrag.txt", content: "Vertragsentwurf", contentType: "text/plain" }];
    const appended = [
      await client.append(nda, await buildRaw({
        from: "partner@partner.example", to: user, subject: "Vertrag Phoenix",
        text: "streng vertraulich", messageId: NDA_MESSAGE_ID, attachments,
      })),
      await client.append(sub, await buildRaw({
        from: "partner@partner.example", to: user, subject: "Projektplan Phoenix",
        text: "ebenfalls vertraulich", attachments,
      })),
      await client.append("INBOX", await buildRaw({
        from: "partner@partner.example", to: user, subject: "Re: Vertrag",
        text: "Haben Sie den Entwurf erhalten?", inReplyTo: NDA_MESSAGE_ID, references: [NDA_MESSAGE_ID],
      })),
    ];
    expect(appended.every(Boolean)).toBe(true);
    ndaUid = await onlyUid(client, nda);
    subUid = await onlyUid(client, sub);
    replyUid = await onlyUid(client, "INBOX");

    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-warden-it-downloads-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-warden-it-state-"));
    const config = ConfigSchema.parse({
      version: 2,
      accounts: [{
        id: "main",
        email: user,
        imap: { host: HOST, port: 3143 },
        permissions: { read: true, write: true, send: false, delete: true },
        policy: { folders: { deny: ["_NDA_Inbox"] } },
      }],
      files: { downloadDir },
    });
    const secrets = { get: async () => "secret", set: async () => {}, delete: async () => {} };
    const app = createAppContext(config, secrets, { connectImap: () => async () => client, stateDir });
    h = await connectHarness((server) => {
      for (const register of TOOLS) register(server, app);
    });
  });

  afterAll(async () => {
    await h?.close();
    await client?.logout();
    for (const dir of [downloadDir, stateDir]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the folder and its subfolders out of list_folders and get_email_count", async () => {
    const list = await h.call("list_folders");
    expect(list.isError).toBe(false);
    expect(list.json.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(["INBOX", archive]));
    expect(list.text).not.toContain("_NDA_Inbox");

    const counts = await h.call("get_email_count");
    expect(counts.isError).toBe(false);
    expect(counts.json.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(["INBOX", archive]));
    expect(counts.text).not.toContain("_NDA_Inbox");
  });

  it("does not pull the locked original into the conversation of a reply in INBOX", async () => {
    const res = await h.call("get_thread", { folder: "INBOX", uid: replyUid });
    expect(res.isError).toBe(false);
    expect(res.json.messages.map((m: { folder: string }) => m.folder)).toEqual(["INBOX"]);
    expect(res.text).not.toMatch(/streng vertraulich|Vertrag Phoenix/);
  });

  /** The locked folder and its subfolder, by server path and by the spellings the AI might use. */
  const targets = (): Target[] => [
    { folder: nda, uid: ndaUid },
    { folder: sub, uid: subUid },
    { folder: "_NDA_Inbox/Projekt", uid: subUid },
    { folder: "Projekt", uid: subUid },
  ];

  it.each([
    ["get_email_count", "as the folder", (t: Target) => ({ folder: t.folder })],
    ["search_emails", "as the folder", (t: Target) => ({ folder: t.folder })],
    ["read_email", "as the folder", (t: Target) => ({ folder: t.folder, uid: t.uid })],
    ["get_thread", "as the folder", (t: Target) => ({ folder: t.folder, uid: t.uid })],
    ["get_thread", "as an extra folder", (t: Target) => ({ folder: "INBOX", uid: replyUid, extraFolders: [t.folder] })],
    ["summarize_senders", "as the folder", (t: Target) => ({ folder: t.folder })],
    ["download_attachment", "as the folder", (t: Target) => ({ folder: t.folder, uid: t.uid, attachmentIndex: 0 })],
    ["save_attachment", "as the folder", (t: Target) => ({ folder: t.folder, uid: t.uid, attachmentIndex: 0 })],
    ["mark_as_read", "as the folder", (t: Target) => ({ folder: t.folder, uids: [t.uid] })],
    ["flag_email", "as the folder", (t: Target) => ({ folder: t.folder, uids: [t.uid], action: "add", flags: ["\\Flagged"] })],
    ["move_email", "as the source", (t: Target) => ({ folder: t.folder, uids: [t.uid], destination: "INBOX" })],
    ["move_email", "as the destination", (t: Target) => ({ folder: "INBOX", uids: [replyUid], destination: t.folder })],
    ["organize_by_filter", "as the source", (t: Target) => ({ folder: t.folder, filter: { all: true }, action: { type: "markRead" } })],
    ["organize_by_filter", "as the destination", (t: Target) => ({ folder: "INBOX", filter: { all: true }, action: { type: "move", destination: t.folder } })],
    ["delete_email", "by UID", (t: Target) => ({ folder: t.folder, uids: [t.uid] })],
    ["delete_email", "by filter", (t: Target) => ({ folder: t.folder, filter: { all: true } })],
    ["reply_draft", "as the original's folder", (t: Target) => ({ folder: t.folder, uid: t.uid, body: "Danke" })],
    ["forward_draft", "as the original's folder", (t: Target) => ({ folder: t.folder, uid: t.uid, to: "kollege@example.com" })],
    ["rename_folder", "as the folder to rename", (t: Target) => ({ path: t.folder, newPath: "Offen" })],
    ["delete_folder", "as the folder to delete", (t: Target) => ({ path: t.folder })],
  ] as const)("refuses %s with it %s, says that nothing was changed, and changes nothing", async (tool, _role, args) => {
    const before = await snapshot(client);
    for (const target of targets()) {
      const res = await h.call(tool, args(target));
      expect(res.isError, `${tool} ${target.folder}`).toBe(true);
      expect(res.text, `${tool} ${target.folder}`).toMatch(DENIED);
    }
    expect(await snapshot(client)).toEqual(before);
    expect(fs.readdirSync(downloadDir)).toEqual([]);
  });

  it.each([
    ["create_folder", "below it", () => ({ path: `_NDA_Inbox${delimiter}Neu` })],
    ["create_folder", "below it, written with /", () => ({ path: "_NDA_Inbox/Neu" })],
    ["create_folder", "with its name", () => ({ path: "_NDA_Inbox" })],
    ["rename_folder", "into it", () => ({ path: archive, newPath: `_NDA_Inbox${delimiter}Archiv` })],
    ["rename_folder", "onto its name", () => ({ path: archive, newPath: "_NDA_Inbox" })],
    ["rename_folder", "out of it", () => ({ path: sub, newPath: "Projekt" })],
    ["delete_folder", "for its empty subfolder", () => ({ path: empty })],
  ] as const)("refuses %s %s and changes nothing", async (tool, _role, args) => {
    const before = await snapshot(client);
    const res = await h.call(tool, args());
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(DENIED);
    expect(await snapshot(client)).toEqual(before);
  });
});
