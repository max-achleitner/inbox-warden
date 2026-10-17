import { describe, it, expect } from "vitest";
import { FolderNotFoundError, matchFolder, pickSpecialFolder, type FolderInfo } from "../folders.js";

function folder(path: string, extra: Partial<FolderInfo> = {}): FolderInfo {
  const delimiter = path.includes(".") ? "." : "/";
  return { path, name: path.split(delimiter).pop()!, delimiter, selectable: true, ...extra };
}

describe("matchFolder", () => {
  const folders = [
    folder("INBOX"),
    folder("INBOX.Archive"),
    folder("INBOX.Kunden"),
    folder("INBOX.Kunden.Müller"),
    folder("Projects", { selectable: false }),
  ];

  it("normalises INBOX case", () => {
    expect(matchFolder(folders, "inbox")).toBe("INBOX");
  });

  it("matches case-insensitively", () => {
    expect(matchFolder(folders, "inbox.archive")).toBe("INBOX.Archive");
  });

  it("matches across delimiters", () => {
    expect(matchFolder(folders, "INBOX/Kunden/Müller")).toBe("INBOX.Kunden.Müller");
  });

  it("matches a unique leaf name", () => {
    expect(matchFolder(folders, "Archive")).toBe("INBOX.Archive");
  });

  it("never resolves to a \\Noselect folder", () => {
    expect(() => matchFolder(folders, "Projects")).toThrow(FolderNotFoundError);
  });

  it("throws with suggestions for unknown folders", () => {
    try {
      matchFolder(folders, "Kunde");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FolderNotFoundError);
      expect((err as Error).message).toContain('"INBOX.Kunden"');
    }
  });
});

describe("pickSpecialFolder", () => {
  it("prefers the SPECIAL-USE flag", () => {
    const folders = [folder("Sent"), folder("Gesendete Elemente", { specialUse: "\\Sent" })];
    expect(pickSpecialFolder(folders, "\\Sent")).toBe("Gesendete Elemente");
  });

  it("falls back to well-known German names", () => {
    expect(pickSpecialFolder([folder("INBOX"), folder("Papierkorb")], "\\Trash")).toBe("Papierkorb");
  });

  it("does not match a same-named subfolder", () => {
    expect(pickSpecialFolder([folder("Kunde A/Sent")], "\\Sent")).toBeNull();
  });

  it("recognises a Trash folder named Deleted, as the old delete_email did", () => {
    expect(pickSpecialFolder([folder("INBOX"), folder("Sent"), folder("Deleted")], "\\Trash")).toBe("Deleted");
    expect(pickSpecialFolder([folder("INBOX"), folder("INBOX.Deleted")], "\\Trash")).toBe("INBOX.Deleted");
  });
});
