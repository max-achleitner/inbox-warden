import { describe, it, expect } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const template = fileURLToPath(new URL("../templates/preflight.cjs", import.meta.url));

/** Lay out a fake bundle: <dir>/package.json (type module), server/preflight.cjs, server/bin.js. */
function fakeBundle(dirName) {
  const root = join(mkdtempSync(join(tmpdir(), "mcpb-")), dirName);
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "server", "bin.js"), 'process.stdout.write("started " + process.argv.slice(2).join(" "));\n');
  copyFileSync(template, join(root, "server", "preflight.cjs"));
  return join(root, "server", "preflight.cjs");
}

describe("preflight.cjs", () => {
  it("starts the server from a path with spaces and umlauts", () => {
    const preflight = fakeBundle("Max Müller");
    const result = spawnSync(process.execPath, [preflight, "serve"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("started serve");
  });

  it("rejects an old Node.js with a clear message", () => {
    const preflight = fakeBundle("old-node");
    const script = `Object.defineProperty(process.versions, "node", { value: "18.20.4" }); require(${JSON.stringify(preflight)});`;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("needs Node.js 20 or newer, but this host runs Node.js 18.20.4");
    expect(result.stdout).toBe("");
  });

  it("reports a server that fails to load in one line", () => {
    const preflight = fakeBundle("broken");
    writeFileSync(join(preflight, "..", "bin.js"), "throw new Error('boom');\n");
    const result = spawnSync(process.execPath, [preflight, "serve"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("inbox-warden failed to start: boom");
  });
});
