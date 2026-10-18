import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxError, resolveDownloadTarget, resolveInside, sanitizeFilename } from "../sandbox.js";

// Records every path handed to realpath(); a network path fails at once instead of reaching the network
const resolved = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (p: Parameters<typeof actual.realpath>[0]) => {
      const text = String(p);
      resolved.push(text);
      if (/^[\\/]{2}/.test(text)) throw Object.assign(new Error("network path in a test"), { code: "ENOENT" });
      return actual.realpath(p);
    },
  };
});

describe("sandbox", () => {
  let base: string;
  let allowed: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "imap-mcp-sandbox-"));
    allowed = path.join(base, "allowed");
    outside = path.join(base, "outside");
    await mkdir(path.join(allowed, "Angebote"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(allowed, "Angebote", "Angebot_Größe.pdf"), "%PDF");
    await writeFile(path.join(outside, "secret.txt"), "secret");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("resolves a relative path inside an allowed folder", async () => {
    const real = await resolveInside([allowed], "Angebote/Angebot_Größe.pdf");
    expect(path.basename(real)).toBe("Angebot_Größe.pdf");
  });

  it("accepts an absolute path inside an allowed folder", async () => {
    await expect(resolveInside([allowed], path.join(allowed, "Angebote", "Angebot_Größe.pdf"))).resolves.toContain("Angebot_Größe.pdf");
  });

  it("rejects ../ traversal (both separators)", async () => {
    await expect(resolveInside([allowed], "../outside/secret.txt")).rejects.toThrow(/outside the folders allowed/);
    await expect(resolveInside([allowed], "..\\outside\\secret.txt")).rejects.toThrow(SandboxError);
  });

  it("rejects an absolute path elsewhere", async () => {
    await expect(resolveInside([allowed], path.join(outside, "secret.txt"))).rejects.toThrow(/outside the folders allowed/);
  });

  it.skipIf(process.platform !== "win32").each(["\\\\files.attacker.example\\c\\Q3.pdf", "//files.attacker.example/c/Q3.pdf", "\\\\?\\UNC\\files.attacker.example\\c\\Q3.pdf"])(
    "refuses the network path %s without opening it, so Windows sends no login to that host",
    async (requested) => {
      resolved.length = 0;
      await expect(resolveInside([allowed], requested)).rejects.toThrow(/outside the folders allowed/);
      expect(resolved.filter((p) => /attacker/.test(p))).toEqual([]);
    },
  );

  it("rejects a symlink/junction that points outside", async () => {
    await symlink(outside, path.join(allowed, "link"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveInside([allowed], "link/secret.txt")).rejects.toThrow(/outside the folders allowed/);
  });

  it("explains when no folder is configured", async () => {
    await expect(resolveInside([], "x.pdf")).rejects.toThrow(/files\.attachmentDirs/);
  });

  it("reports missing files", async () => {
    await expect(resolveInside([allowed], "nope.pdf")).rejects.toThrow(/not found/);
  });

  it("creates the download folder and never overwrites", async () => {
    const dir = path.join(base, "downloads");
    const first = await resolveDownloadTarget(dir, "Rechnung.pdf");
    expect(path.basename(first)).toBe("Rechnung.pdf");
    await writeFile(first, "x");
    expect(path.basename(await resolveDownloadTarget(dir, "Rechnung.pdf"))).toBe("Rechnung (1).pdf");
  });

  it("refuses to save when no download folder is configured", async () => {
    await expect(resolveDownloadTarget(undefined, "a.pdf")).rejects.toThrow(/files\.downloadDir/);
  });
});

describe("sanitizeFilename", () => {
  it.each([
    ["../../evil.pdf", "evil.pdf"],
    ["..\\..\\evil.pdf", "evil.pdf"],
    ["CON.txt", "_CON.txt"],
    ["a<b>c:d|e?.pdf", "a_b_c_d_e_.pdf"],
    [".bashrc", "bashrc"],
    ["   ", "attachment"],
    ["Angebot Größe.pdf", "Angebot Größe.pdf"],
  ])("%s → %s", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });
});

// The executable/macro file-type cases moved to src/policy/__tests__/engine.test.ts (isExecutableFilename).
