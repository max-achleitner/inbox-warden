import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as moveEmail from "../move-email.js";
import * as deleteEmail from "../delete-email.js";
import * as manageFolders from "../manage-folders.js";
import * as downloadAttachment from "../download-attachment.js";
import * as saveAttachment from "../save-attachment.js";
import * as organizeByFilter from "../organize-by-filter.js";

function raw(from: string, subject: string): string {
  return `From: ${from}\r\nSubject: ${subject}\r\nDate: Thu, 15 Jan 2026 10:00:00 +0000\r\n\r\nx`;
}

describe("policy limits in tools", () => {
  it("refuses a move above bulk.maxMessages and changes nothing", async () => {
    const t = createTestApp([{ policy: { bulk: { maxMessages: 2 } } }]);
    t.imap().addFolder("Archive");
    for (const s of ["a", "b", "c"]) t.imap().addMessage("INBOX", `Subject: ${s}\r\n\r\nx`);
    const h = await t.connect(moveEmail.register);
    const res = await h.call("move_email", { uids: [1, 2, 3], destination: "Archive" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/3 messages match, more than the limit of 2/);
    expect(t.imap().uidsIn("INBOX")).toEqual([1, 2, 3]);
    await h.close();
  });

  it("uses the stricter maxDelete for delete_email", async () => {
    const t = createTestApp([{ policy: { bulk: { maxMessages: 500, maxDelete: 1 } } }]);
    for (const s of ["a", "b"]) t.imap().addMessage("INBOX", `Subject: ${s}\r\n\r\nx`);
    const h = await t.connect(deleteEmail.register);
    const res = await h.call("delete_email", { uids: [1, 2] });
    expect(res.isError).toBe(true);
    expect(t.imap().uidsIn("INBOX")).toEqual([1, 2]);
    await h.close();
  });

  describe("moving into Trash counts as deleting", () => {
    function trashApp(permissions: { delete?: boolean }, bulk: Record<string, number> = {}) {
      const t = createTestApp([{ permissions, policy: { bulk } }]);
      t.imap().addFolder("Trash/Alt");
      for (const s of ["a", "b", "c"]) t.imap().addMessage("INBOX", raw("news@shop.example", s));
      return t;
    }

    it("move_email refuses Trash without the delete permission", async () => {
      const t = trashApp({ delete: false });
      const h = await t.connect(moveEmail.register);
      for (const destination of ["Trash", "Trash/Alt"]) {
        const res = await h.call("move_email", { uids: [1], destination });
        expect(res.isError).toBe(true);
        expect(res.text).toMatch(/Trash folder deletes them.*Nothing was moved/s);
      }
      expect(t.imap().uidsIn("INBOX")).toEqual([1, 2, 3]);
      await h.close();
    });

    it("move_email applies bulk.maxDelete to Trash moves", async () => {
      const t = trashApp({ delete: true }, { maxMessages: 500, maxDelete: 1 });
      const h = await t.connect(moveEmail.register);
      const res = await h.call("move_email", { uids: [1, 2], destination: "Trash" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/limit of 1 per operation for deleting/);
      expect(t.imap().uidsIn("INBOX")).toEqual([1, 2, 3]);
      await h.close();
    });

    it("organize_by_filter refuses a Trash move without the delete permission", async () => {
      const t = trashApp({ delete: false });
      const h = await t.connect(organizeByFilter.register);
      const res = await h.call("organize_by_filter", { filter: {}, action: { type: "move", destination: "Trash" } });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Trash folder deletes them/);
      await h.close();
    });

    it("organize_by_filter applies bulk.maxDelete to Trash moves", async () => {
      const t = trashApp({ delete: true }, { maxMessages: 500, maxDelete: 2 });
      const h = await t.connect(organizeByFilter.register);
      const res = await h.call("organize_by_filter", { filter: {}, action: { type: "move", destination: "Trash" } });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/3 messages match, more than the limit of 2 per operation for deleting/);
      await h.close();
    });

    it("still allows Trash moves with the delete permission", async () => {
      const t = trashApp({ delete: true });
      const h = await t.connect(moveEmail.register);
      const res = await h.call("move_email", { uids: [1], destination: "Trash" });
      expect(res.isError).toBe(false);
      expect(t.imap().uidsIn("Trash")).toEqual([1]);
      await h.close();
    });

    function clientsFolder(t: ReturnType<typeof trashApp>) {
      t.imap().addFolder("Clients");
      t.imap().addFolder("Clients/2025");
      t.imap().addMessage("Clients", raw("a@example.com", "one"));
      t.imap().addMessage("Clients", raw("a@example.com", "two"));
      t.imap().addMessage("Clients/2025", raw("a@example.com", "three"));
    }

    it("rename_folder refuses moving a folder into Trash without the delete permission", async () => {
      const t = trashApp({ delete: false });
      clientsFolder(t);
      const h = await t.connect(manageFolders.registerRename);
      for (const newPath of ["Trash/Clients", "trash/Clients"]) {
        const res = await h.call("rename_folder", { path: "Clients", newPath });
        expect(res.isError).toBe(true);
        expect(res.text).toMatch(/Trash folder deletes them/);
      }
      expect(t.imap().folders.has("Clients")).toBe(true);
      expect(t.imap().folders.has("Clients/2025")).toBe(true);
      await h.close();
    });

    it("rename_folder applies bulk.maxDelete to every message the folder takes into Trash, subfolders included", async () => {
      const t = trashApp({ delete: true }, { maxMessages: 500, maxDelete: 2 });
      clientsFolder(t);
      const h = await t.connect(manageFolders.registerRename);
      const res = await h.call("rename_folder", { path: "Clients", newPath: "Trash/Clients" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/3 messages match, more than the limit of 2 per operation for deleting/);
      expect(t.imap().folders.has("Clients")).toBe(true);
      await h.close();
    });

    it("rename_folder moves a folder into Trash with the delete permission", async () => {
      const t = trashApp({ delete: true });
      clientsFolder(t);
      const h = await t.connect(manageFolders.registerRename);
      const res = await h.call("rename_folder", { path: "Clients", newPath: "Trash/Clients" });
      expect(res.isError).toBe(false);
      expect([...t.imap().folders.keys()]).toEqual(expect.arrayContaining(["Trash/Clients", "Trash/Clients/2025"]));
      await h.close();
    });
  });

  describe('servers with a namespace prefix ("INBOX.")', () => {
    function prefixedApp(permissions: { delete?: boolean }, folders: Record<string, unknown>) {
      const imap = new FakeImap();
      imap.namespace = { prefix: "INBOX/", delimiter: "/" };
      imap.addFolder("INBOX/Drafts", { specialUse: "\\Drafts" });
      imap.addFolder("INBOX/Trash", { specialUse: "\\Trash" });
      imap.addFolder("INBOX/Projects");
      return createTestApp([{ imap, permissions, policy: { folders } }]);
    }

    it("create_folder checks the folder policy on the path the server really creates", async () => {
      const t = prefixedApp({}, { deny: ["INBOX/Secret/**"] });
      const h = await t.connect(manageFolders.registerCreate);
      const res = await h.call("create_folder", { path: "Secret/Leak" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/blocked by your administrator's policy/);
      expect(t.imap().folders.has("INBOX/Secret/Leak")).toBe(false);
      await h.close();
    });

    it("create_folder allows a path that an allow rule covers once the prefix is added", async () => {
      const t = prefixedApp({}, { allow: ["INBOX/Projects/**"] });
      const h = await t.connect(manageFolders.registerCreate);
      const res = await h.call("create_folder", { path: "Projects/2026" });
      expect(res.isError).toBe(false);
      expect(res.json.path).toBe("INBOX/Projects/2026");
      expect(t.imap().folders.has("INBOX/Projects/2026")).toBe(true);
      await h.close();
    });

    it("rename_folder treats the prefixed target as a Trash move", async () => {
      const t = prefixedApp({ delete: false }, {});
      const h = await t.connect(manageFolders.registerRename);
      const res = await h.call("rename_folder", { path: "INBOX/Projects", newPath: "Trash/Projects" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Trash folder deletes them/);
      expect(t.imap().folders.has("INBOX/Projects")).toBe(true);
      await h.close();
    });

    it("rename_folder checks the folder policy on the prefixed target", async () => {
      const t = prefixedApp({}, { deny: ["INBOX/Secret/**"] });
      const h = await t.connect(manageFolders.registerRename);
      const res = await h.call("rename_folder", { path: "INBOX/Projects", newPath: "Secret/Projects" });
      expect(res.isError).toBe(true);
      expect(t.imap().folders.has("INBOX/Projects")).toBe(true);
      await h.close();
    });
  });

  it("previews a bulk change over a message whose Date header cannot be parsed", async () => {
    const t = createTestApp();
    t.imap().addFolder("Archive");
    t.imap().addMessage("INBOX", "From: spam@example.com\r\nSubject: Gewinn\r\nDate: garbage\r\n\r\nx");
    const h = await t.connect(organizeByFilter.register);
    const res = await h.call("organize_by_filter", { filter: {}, action: { type: "move", destination: "Archive" } });
    expect(res.isError).toBe(false);
    expect(res.json.sample[0]).toMatchObject({ subject: "Gewinn" });
    expect(res.json.sample[0].date).toBeUndefined();
    await h.close();
  });

  it("protects INBOX and special-use folders from rename and delete", async () => {
    const t = createTestApp();
    const h = await t.connect(manageFolders.registerRename, manageFolders.registerDelete);
    expect((await h.call("rename_folder", { path: "INBOX", newPath: "Posteingang" })).text).toMatch(/protected/);
    expect((await h.call("delete_folder", { path: "Sent" })).text).toMatch(/protected/);
    expect(t.imap().folders.has("Sent")).toBe(true);
    await h.close();
  });

  it("refuses renaming a folder whose subfolders are hidden, so they cannot escape the deny rule", async () => {
    const t = createTestApp([{ policy: { folders: { deny: ["Archive/Secret"] } } }]);
    t.imap().addFolder("Archive");
    t.imap().addFolder("Archive/Secret");
    const h = await t.connect(manageFolders.registerRename);
    const res = await h.call("rename_folder", { path: "Archive", newPath: "Old" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/folder policy.*Nothing was renamed/);
    expect(res.text).not.toContain("Secret");
    expect([...t.imap().folders.keys()]).toEqual(expect.arrayContaining(["Archive", "Archive/Secret"]));
    await h.close();
  });

  it("renames a folder together with its visible subfolders", async () => {
    const t = createTestApp();
    t.imap().addFolder("Archive");
    t.imap().addFolder("Archive/2025");
    const h = await t.connect(manageFolders.registerRename);
    const res = await h.call("rename_folder", { path: "Archive", newPath: "Old" });
    expect(res.isError).toBe(false);
    expect([...t.imap().folders.keys()]).toEqual(expect.arrayContaining(["Old", "Old/2025"]));
    await h.close();
  });

  it("refuses creating a folder inside a denied area", async () => {
    const t = createTestApp([{ policy: { folders: { deny: ["**/HR/**"] } } }]);
    const h = await t.connect(manageFolders.registerCreate);
    const res = await h.call("create_folder", { path: "HR/2026" });
    expect(res.isError).toBe(true);
    expect(t.imap().folders.has("HR/2026")).toBe(false);
    await h.close();
  });

  it("refuses attachments above maxDownloadBytes", async () => {
    const t = createTestApp([{ policy: { attachments: { maxDownloadBytes: 10 } } }]);
    t.imap().addMessage(
      "INBOX",
      await buildRaw({
        from: "a@example.com",
        to: "max@firma.example",
        subject: "Datei",
        text: "Anbei",
        attachments: [{ filename: "gross.txt", content: "x".repeat(100) }],
      }),
    );
    const h = await t.connect(downloadAttachment.register);
    const res = await h.call("download_attachment", { uid: 1, attachmentIndex: 0 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/your policy allows at most 1 KB/);
    await h.close();
  });

  it("refuses saving attachments above maxDownloadBytes and writes nothing", async () => {
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-dl-"));
    const t = createTestApp([{ policy: { attachments: { maxDownloadBytes: 1024 } } }], { files: { downloadDir } });
    t.imap().addMessage(
      "INBOX",
      await buildRaw({
        from: "a@example.com",
        to: "max@firma.example",
        subject: "Datei",
        text: "Anbei",
        attachments: [{ filename: "gross.pdf", content: Buffer.alloc(4096, 1), contentType: "application/pdf" }],
      }),
    );
    const h = await t.connect(saveAttachment.register);
    const res = await h.call("save_attachment", { uid: 1, attachmentIndex: 0 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/your policy allows at most 1 KB/);
    expect(fs.readdirSync(downloadDir)).toEqual([]);
    await h.close();
  });
});
