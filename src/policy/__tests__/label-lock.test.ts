import { describe, it, expect } from "vitest";
import type { FolderInfo } from "../../imap/folders.js";
import type { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { gmailFakeImap, standardFakeImap } from "../../__tests__/helpers/test-app.js";
import type { FolderRules } from "../folder-rules.js";
import { LabelLock, labelDenied, labelLockApplies } from "../label-lock.js";

/** Gmail's folders as listed in German (the owner's account): system folders are named per locale. */
const FOLDERS: FolderInfo[] = [
  { path: "INBOX", name: "INBOX", delimiter: "/", selectable: true },
  { path: "[Gmail]", name: "[Gmail]", delimiter: "/", selectable: false },
  { path: "[Gmail]/Alle Nachrichten", name: "Alle Nachrichten", delimiter: "/", specialUse: "\\All", selectable: true, aggregate: true },
  { path: "[Gmail]/Entwürfe", name: "Entwürfe", delimiter: "/", specialUse: "\\Drafts", selectable: true },
  { path: "[Gmail]/Gesendet", name: "Gesendet", delimiter: "/", specialUse: "\\Sent", selectable: true },
  { path: "[Gmail]/Papierkorb", name: "Papierkorb", delimiter: "/", specialUse: "\\Trash", selectable: true },
  { path: "[Gmail]/Spam", name: "Spam", delimiter: "/", specialUse: "\\Junk", selectable: true },
  { path: "[Gmail]/Markiert", name: "Markiert", delimiter: "/", specialUse: "\\Flagged", selectable: true, aggregate: true },
  { path: "[Gmail]/Wichtig", name: "Wichtig", delimiter: "/", selectable: true, aggregate: true },
  { path: "_NDA_Inbox", name: "_NDA_Inbox", delimiter: "/", selectable: true },
  { path: "Kunden", name: "Kunden", delimiter: "/", selectable: true },
];

const denied = (label: string, deny: string[], folders = FOLDERS) => labelDenied(label, { deny }, folders);

describe("labelDenied", () => {
  it("checks a user label as the folder path it stands for, subfolders and any depth included", () => {
    expect(denied("_NDA_Inbox", ["_NDA_Inbox"])).toBe(true);
    expect(denied("_nda_inbox", ["_NDA_Inbox"])).toBe(true);
    expect(denied("_NDA_Inbox/Projekt", ["_NDA_Inbox"])).toBe(true);
    expect(denied("Kunden/_NDA_Inbox", ["_NDA_Inbox"])).toBe(true);
    expect(denied("Kunden/_NDA_Alpha", ["_NDA_*"])).toBe(true);
    expect(denied("Kunden/_NDA_Alpha", ["/_NDA_*"])).toBe(false);
    expect(denied("_NDA_Inbox", ["INBOX/_NDA_Inbox"])).toBe(true);
    expect(denied("Kunden", ["_NDA_Inbox"])).toBe(false);
    expect(denied("_NDA_Inbox_alt", ["_NDA_Inbox"])).toBe(false);
  });

  it("checks \\Inbox as INBOX", () => {
    expect(denied("\\Inbox", ["INBOX"])).toBe(true);
    expect(denied("\\Inbox", ["inbox"])).toBe(true);
    expect(denied("\\Inbox", ["Kunden"])).toBe(false);
  });

  it.each([
    ["\\Sent", "[Gmail]/Gesendet"],
    ["\\Draft", "[Gmail]/Entwürfe"],
    ["\\Drafts", "[Gmail]/Entwürfe"],
    ["\\Trash", "[Gmail]/Papierkorb"],
    ["\\Spam", "[Gmail]/Spam"],
    ["\\Junk", "[Gmail]/Spam"],
  ])("checks %s as the special-use folder %s, whatever the locale calls it", (label, folder) => {
    expect(denied(label, [folder])).toBe(true);
    expect(denied(label.toUpperCase(), [folder])).toBe(true);
    expect(denied(label, ["[Gmail]/**"])).toBe(true);
    expect(denied(label, ["_NDA_Inbox"])).toBe(false);
  });

  it("does not check a system label by an unrelated folder name of the same word", () => {
    // "Sent" hides a folder named Sent; Gmail's Sent folder here is [Gmail]/Gesendet
    expect(denied("\\Sent", ["Sent"])).toBe(false);
  });

  it("never hides a message for its Important or Starred label (aggregates)", () => {
    expect(denied("\\Important", ["[Gmail]/Wichtig", "Important", "**"])).toBe(false);
    expect(denied("\\Starred", ["[Gmail]/Markiert", "Starred", "**"])).toBe(false);
  });

  it("checks a system label without a listed folder by its bare name", () => {
    expect(denied("\\Spam", ["Spam"], FOLDERS.filter((f) => f.specialUse !== "\\Junk"))).toBe(true);
    expect(denied("\\Chats", ["Chats"])).toBe(true);
    expect(denied("\\Chats", ["Kunden"])).toBe(false);
  });

  it("hides nothing without deny patterns, whatever the allow list says", () => {
    expect(labelDenied("Privat", { allow: ["INBOX"], deny: [] }, FOLDERS)).toBe(false);
  });
});

describe("LabelLock", () => {
  it("applies only on Gmail (X-GM-EXT-1) with deny patterns", () => {
    expect(labelLockApplies(gmailFakeImap().asClient(), { deny: ["_NDA_Inbox"] })).toBe(true);
    expect(labelLockApplies(gmailFakeImap().asClient(), { deny: [], allow: ["INBOX"] })).toBe(false);
    expect(labelLockApplies(standardFakeImap().asClient(), { deny: ["_NDA_Inbox"] })).toBe(false);
  });

  it("returns no check, and sends no IMAP command, where it does not apply", async () => {
    const cases: Array<[FakeImap, FolderRules]> = [
      [standardFakeImap(), { deny: ["_NDA_Inbox"] }],
      [gmailFakeImap(), { deny: [] }],
    ];
    for (const [imap, rules] of cases) {
      expect(await new LabelLock(rules).labelCheck(imap.asClient())).toBeNull();
      expect(imap.calls).toEqual([]);
    }
  });

  it("lists the folders once when it was not given them, and checks a whole label set", async () => {
    const imap = gmailFakeImap(["_NDA_Inbox", "Kunden"]);
    const check = (await new LabelLock({ deny: ["_NDA_Inbox", "[Gmail]/Sent Mail"] }).labelCheck(imap.asClient()))!;
    expect(imap.callsTo("list")).toHaveLength(1);
    expect(check(new Set(["Kunden", "\\Important"]))).toBe(false);
    expect(check(new Set(["Kunden", "_NDA_Inbox"]))).toBe(true);
    expect(check(new Set(["\\Inbox", "\\Sent"]))).toBe(true);
    expect(check(new Set())).toBe(false);
  });

  it("uses the folders it was given instead of listing", async () => {
    const imap = gmailFakeImap();
    await new LabelLock({ deny: ["_NDA_Inbox"] }, FOLDERS).labelCheck(imap.asClient());
    expect(imap.callsTo("list")).toEqual([]);
  });
});
