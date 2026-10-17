import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LEGACY_COMMANDS, PACKAGE_NAME, SERVER_NAME, VERSION } from "../version.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** The only places allowed to spell the pre-1.0 names. */
const ALLOWED = [/^src\/version\.ts$/, /^src\/secrets\//, /^src\/index\.ts$/, /^src\/cli\/main\.ts$/];

/** Value of the keychain service constant as shipped by Plan 4 — this plan must not change it. */
const KEYCHAIN_SERVICE_AT_1_0 = '"imap-mcp"';

describe("product identity", () => {
  it("package.json name and version match src/version.ts", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(SERVER_NAME).toBe("inbox-warden");
    expect(pkg.name).toBe(SERVER_NAME);
    expect(PACKAGE_NAME).toBe(SERVER_NAME);
    expect(VERSION).toBe(pkg.version);
  });

  it("no source file outside the allow-list hard-codes a pre-1.0 name", () => {
    const offenders = sourceFiles(join(root, "src"))
      .map((file) => relative(root, file).split("\\").join("/"))
      .filter((rel) => !ALLOWED.some((re) => re.test(rel)))
      .filter((rel) => LEGACY_COMMANDS.some((name) => readFileSync(join(root, rel), "utf8").includes(name)));
    expect(offenders).toEqual([]);
  });

  it("no source file outside src/version.ts spells the product name in code", () => {
    const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);
    const offenders = sourceFiles(join(root, "src"))
      .map((file) => relative(root, file).split("\\").join("/"))
      .filter((rel) => rel !== "src/version.ts")
      .flatMap((rel) =>
        readFileSync(join(root, rel), "utf8")
          .split("\n")
          .map((line, i) => ({ rel, line: i + 1, text: line }))
          .filter(({ text }) => text.includes(SERVER_NAME) && !isComment(text)),
      )
      .map(({ rel, line }) => `${rel}:${line}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the keychain service name so stored passwords and tokens stay readable", () => {
    const secrets = sourceFiles(join(root, "src", "secrets"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(secrets).toContain(KEYCHAIN_SERVICE_AT_1_0);
  });
});
