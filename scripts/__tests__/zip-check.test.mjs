import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createWriteStream, appendFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { openLikeClaudeDesktop } from "../lib/zip-check.mjs";

let dir;

async function writeZip(file, names) {
  const zip = new yazl.ZipFile();
  for (const name of names) zip.addBuffer(Buffer.from("{}"), name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zip-check-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openLikeClaudeDesktop", () => {
  it("accepts a plain bundle", async () => {
    const file = join(dir, "plain.mcpb");
    await writeZip(file, ["manifest.json", "server/x.js"]);
    const result = await openLikeClaudeDesktop(file);
    expect(result.entries).toBeGreaterThanOrEqual(1);
  });

  it("rejects a bundle with bytes after the ZIP end, like mcpb sign 2.1.2 writes", async () => {
    const plain = join(dir, "base.mcpb");
    const signed = join(dir, "signed.mcpb");
    await writeZip(plain, ["manifest.json"]);
    copyFileSync(plain, signed);
    appendFileSync(signed, Buffer.concat([Buffer.from("MCPB_SIG_V1"), Buffer.alloc(1861, 1)]));
    await expect(openLikeClaudeDesktop(signed)).rejects.toThrow(/Invalid comment length/);
  });

  it("rejects a bundle without manifest.json", async () => {
    const file = join(dir, "nomanifest.mcpb");
    await writeZip(file, ["server/x.js"]);
    await expect(openLikeClaudeDesktop(file)).rejects.toThrow(/manifest\.json/);
  });
});
