import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as manageFolders from "../manage-folders.js";

/**
 * imapflow deselects a folder before RENAME or DELETE of it, with CLOSE when the server lacks
 * UNSELECT, and CLOSE permanently removes every message flagged \Deleted (for example by another
 * mail program). Folder tools must never trigger that.
 */
async function setup() {
  const t = createTestApp();
  const imap = t.imap();
  imap.capabilities.delete("UNSELECT");
  imap.addFolder("Clients");
  imap.addMessage("Clients", "Subject: marked elsewhere\r\n\r\n", { flags: ["\\Deleted"] });
  imap.addMessage("Clients", "Subject: kept\r\n\r\n");
  imap.addFolder("Empty");
  const h = await t.connect(manageFolders.registerRename, manageFolders.registerDelete);
  return { imap, h };
}

describe("folder tools never expunge implicitly", () => {
  it("rename_folder keeps messages marked as deleted when the folder was selected (server without UNSELECT)", async () => {
    const { imap, h } = await setup();
    await imap.getMailboxLock("Clients"); // an earlier tool call left the folder selected
    const res = await h.call("rename_folder", { path: "Clients", newPath: "Kunden" });
    expect(res.isError).toBe(false);
    expect(imap.uidsIn("Kunden")).toEqual([1, 2]);
    expect(imap.callsTo("close")).toHaveLength(0);
    await h.close();
  });

  it("rename_folder of INBOX itself only closes a read-only INBOX", async () => {
    const t = createTestApp([{ policy: { protectedFolders: false } }]);
    const imap = t.imap();
    imap.capabilities.delete("UNSELECT");
    imap.addMessage("INBOX", "Subject: marked elsewhere\r\n\r\n", { flags: ["\\Deleted"] });
    const h = await t.connect(manageFolders.registerRename);
    await imap.getMailboxLock("INBOX");
    const res = await h.call("rename_folder", { path: "INBOX", newPath: "Old Inbox" });
    expect(res.isError).toBe(false);
    expect(imap.uidsIn("Old Inbox")).toEqual([1]);
    await h.close();
  });

  it("delete_folder never sends CLOSE for the folder it deletes (server without UNSELECT)", async () => {
    const { imap, h } = await setup();
    await imap.getMailboxLock("Empty");
    const res = await h.call("delete_folder", { path: "Empty" });
    expect(res.isError).toBe(false);
    expect(imap.folders.has("Empty")).toBe(false);
    expect(imap.callsTo("close")).toHaveLength(0);
    await h.close();
  });

  it("delete_folder refuses a folder that still holds messages marked as deleted", async () => {
    const { imap, h } = await setup();
    imap.message("Clients", 2)!.flags.add("\\Deleted");
    const res = await h.call("delete_folder", { path: "Clients" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Nothing was deleted/);
    expect(imap.uidsIn("Clients")).toEqual([1, 2]);
    await h.close();
  });

  it("delete_folder refuses when the server does not report how many messages the folder holds", async () => {
    const { imap, h } = await setup();
    const status = imap.status.bind(imap);
    imap.status = async (path, query) => {
      const result = await status(path, query);
      if (!result) return result;
      const { messages: _messages, ...rest } = result;
      return rest as typeof result;
    };
    const res = await h.call("delete_folder", { path: "Clients" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Nothing was deleted/);
    expect(imap.folders.has("Clients")).toBe(true);
    await h.close();
  });
});
