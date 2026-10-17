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
});
