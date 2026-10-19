import { describe, it, expect } from "vitest";
import { canonicalFolderPath, folderAllowed, folderPatternToRegExp } from "../folder-rules.js";

describe("folder rules", () => {
  it("canonicalises the server delimiter to /", () => {
    expect(canonicalFolderPath("INBOX.Kunden.HR", ".")).toBe("INBOX/Kunden/HR");
    expect(canonicalFolderPath("INBOX/HR", "/")).toBe("INBOX/HR");
  });

  it("X/** matches X itself and everything below it", () => {
    const re = folderPatternToRegExp("HR/**");
    expect(re.test("HR")).toBe(true);
    expect(re.test("HR/Gehälter/2026")).toBe(true);
    expect(re.test("HRM")).toBe(false);
  });

  it("**/X/** matches X at any depth including the top level", () => {
    const re = folderPatternToRegExp("**/HR/**");
    for (const path of ["HR", "INBOX/HR", "INBOX/HR/Gehälter", "Projekte/A/HR"]) expect(re.test(path)).toBe(true);
    expect(re.test("INBOX/HRM")).toBe(false);
  });

  it("* stays within one level", () => {
    const re = folderPatternToRegExp("Kunden/*");
    expect(re.test("Kunden/Müller")).toBe(true);
    expect(re.test("Kunden/Müller/2026")).toBe(false);
  });

  it("denies case-insensitively regardless of delimiter", () => {
    const rules = { deny: ["**/hr/**"] };
    expect(folderAllowed("INBOX.HR", ".", rules)).toBe(false);
    expect(folderAllowed("INBOX/hr/Gehälter", "/", rules)).toBe(false);
    expect(folderAllowed("INBOX/Archive", "/", rules)).toBe(true);
  });

  it("deny wins over allow, and allow restricts everything else", () => {
    const rules = { allow: ["INBOX", "Archiv/**"], deny: ["Archiv/Privat/**"] };
    expect(folderAllowed("INBOX", "/", rules)).toBe(true);
    expect(folderAllowed("Archiv/2025", "/", rules)).toBe(true);
    expect(folderAllowed("Archiv/Privat", "/", rules)).toBe(false);
    expect(folderAllowed("Projekte", "/", rules)).toBe(false);
  });

  it("treats regex characters in folder names literally", () => {
    expect(folderAllowed("Kunden (alt)", "/", { deny: ["Kunden (alt)"] })).toBe(false);
    expect(folderAllowed("Kunden xalt)", "/", { deny: ["Kunden (alt)"] })).toBe(true);
  });

  describe("a denied folder takes everything below it along", () => {
    const nda = { deny: ["_NDA_Inbox"] };

    it.each([
      ["_NDA_Inbox", "/"],
      ["_NDA_Inbox/Projekt", "/"],
      ["_NDA_Inbox/Projekt/2026", "/"],
      ["_nda_inbox/Projekt", "/"],
      ["_NDA_Inbox.Projekt", "."],
    ])("deny _NDA_Inbox hides %s", (path, delimiter) => {
      expect(folderAllowed(path, delimiter, nda)).toBe(false);
    });

    it("leaves folders alone that only share the beginning of the name, or hold it deeper down", () => {
      expect(folderAllowed("_NDA_Inbox2", "/", nda)).toBe(true);
      expect(folderAllowed("_NDA_Inbox_alt/Projekt", "/", nda)).toBe(true);
      expect(folderAllowed("Projekte/_NDA_Inbox", "/", nda)).toBe(true);
    });

    it("applies to the folders a glob matches as well", () => {
      const clients = { deny: ["Kunden/*"] };
      expect(folderAllowed("Kunden/Müller/2026", "/", clients)).toBe(false);
      expect(folderAllowed("Kunden", "/", clients)).toBe(true);
      expect(folderAllowed("Projekte/Privat/Fotos", "/", { deny: ["**/Privat"] })).toBe(false);
    });

    it("hides every subfolder of INBOX when INBOX itself is denied", () => {
      expect(folderAllowed("INBOX", "/", { deny: ["INBOX"] })).toBe(false);
      expect(folderAllowed("INBOX/Kunden", "/", { deny: ["INBOX"] })).toBe(false);
      expect(folderAllowed("Archiv", "/", { deny: ["INBOX"] })).toBe(true);
    });
  });

  describe("the INBOX namespace prefix (Dovecot, Courier, Cyrus) does not matter", () => {
    const nda = { deny: ["_NDA_Inbox"] };

    it.each([
      ["INBOX._NDA_Inbox", "."],
      ["INBOX._NDA_Inbox.Projekt", "."],
      ["INBOX/_NDA_Inbox", "/"],
      ["inbox/_nda_inbox/Projekt", "/"],
    ])("deny _NDA_Inbox hides %s", (path, delimiter) => {
      expect(folderAllowed(path, delimiter, nda)).toBe(false);
    });

    it("keeps INBOX itself and its other subfolders visible", () => {
      expect(folderAllowed("INBOX", ".", nda)).toBe(true);
      expect(folderAllowed("INBOX.Kunden", ".", nda)).toBe(true);
      expect(folderAllowed("INBOX.Kunden._NDA_Inbox", ".", nda)).toBe(true);
    });

    it("still matches a pattern written with the prefix", () => {
      const prefixed = { deny: ["INBOX/_NDA_Inbox"] };
      expect(folderAllowed("INBOX._NDA_Inbox", ".", prefixed)).toBe(false);
      expect(folderAllowed("INBOX._NDA_Inbox.Projekt", ".", prefixed)).toBe(false);
    });

    it("also hides a real INBOX subfolder of the same name on servers without the prefix", () => {
      expect(folderAllowed("INBOX/HR", "/", { deny: ["HR"] })).toBe(false);
    });

    it("matches allow patterns without the prefix too", () => {
      const rules = { allow: ["INBOX", "Archiv/**"], deny: [] };
      expect(folderAllowed("INBOX", ".", rules)).toBe(true);
      expect(folderAllowed("INBOX.Archiv", ".", rules)).toBe(true);
      expect(folderAllowed("INBOX.Archiv.2025", ".", rules)).toBe(true);
      expect(folderAllowed("INBOX.Projekte", ".", rules)).toBe(false);
    });

    it("never lets an allowed folder unlock the folders below it", () => {
      const rules = { allow: ["INBOX", "Archiv"], deny: [] };
      expect(folderAllowed("Archiv", "/", rules)).toBe(true);
      expect(folderAllowed("Archiv/Privat", "/", rules)).toBe(false);
      expect(folderAllowed("INBOX.Projekte", ".", rules)).toBe(false);
    });

    it("lets deny win over allow below the prefix", () => {
      const rules = { allow: ["**"], deny: ["_NDA_Inbox"] };
      expect(folderAllowed("INBOX.Kunden", ".", rules)).toBe(true);
      expect(folderAllowed("INBOX._NDA_Inbox.Projekt", ".", rules)).toBe(false);
    });
  });
});
