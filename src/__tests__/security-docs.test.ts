import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../config/schema.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("security documentation", () => {
  it.each([
    "SECURITY.md",
    "docs/security/threat-model.md",
    "docs/security/data-flow.md",
    "docs/security/hardening-guide.md",
    "docs/security/sicherheitsuebersicht.md",
  ])("%s exists", (file) => {
    expect(read(file).length).toBeGreaterThan(500);
  });

  it("the hardening guide's baseline configuration is valid", () => {
    const guide = read("docs/security/hardening-guide.md");
    const json = /```json\n([\s\S]*?)\n```/.exec(guide.replace(/\r\n/g, "\n"))![1];
    const config = ConfigSchema.parse(JSON.parse(json));
    expect(config.accounts[0].policy.send.mode).toBe("drafts-only");
  });

  it("README links the security documentation", () => {
    expect(read("README.md")).toContain("docs/security/");
  });
});
