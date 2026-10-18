import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, type TestApp } from "../../__tests__/helpers/test-app.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as listFolders from "../list-folders.js";
import * as searchEmails from "../search-emails.js";
import * as readEmail from "../read-email.js";
import * as moveEmail from "../move-email.js";
import * as getEmailCount from "../get-email-count.js";
import * as getThread from "../get-thread.js";

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
    expect(res.text).toMatch(/blocked by your administrator's policy/);
  });

  it("refuses read_email and get_email_count in a denied folder", async () => {
    expect((await h.call("read_email", { folder: "HR", uid: 1 })).isError).toBe(true);
    expect((await h.call("get_email_count", { folder: "INBOX/HR" })).isError).toBe(true);
  });

  it("refuses get_thread in a denied folder or across one", async () => {
    expect((await h.call("get_thread", { folder: "INBOX/HR", uid: 1 })).isError).toBe(true);
    const across = await h.call("get_thread", { uid: 1, extraFolders: ["HR"] });
    expect(across.isError).toBe(true);
    expect(across.text).toMatch(/blocked by your administrator's policy/);
  });

  it("refuses moving mail into a denied folder", async () => {
    const res = await h.call("move_email", { uids: [1], destination: "INBOX/HR" });
    expect(res.isError).toBe(true);
    expect(t.imap().uidsIn("INBOX")).toEqual([1]);
  });
});
