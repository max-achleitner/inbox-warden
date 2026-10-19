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

  /** Run the preflight as if the host's Node.js had `version`. */
  function runAs(version, dirName) {
    const preflight = fakeBundle(dirName);
    const script = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} }); require(${JSON.stringify(preflight)});`;
    return spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  }

  it.each(["18.20.4", "20.18.1"])("rejects Node.js %s with a clear message", (version) => {
    const result = runAs(version, "old-node");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`needs Node.js 20.19 or newer, but this host runs Node.js ${version}`);
    expect(result.stdout).toBe("");
  });

  it.each(["20.19.0", "24.21.0"])("starts on Node.js %s", (version) => {
    const result = runAs(version, "new-node");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("started");
  });

  it("reports a server that fails to load in one line", () => {
    const preflight = fakeBundle("broken");
    writeFileSync(join(preflight, "..", "bin.js"), "throw new Error('boom');\n");
    const result = spawnSync(process.execPath, [preflight, "serve"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("inbox-warden failed to start: boom");
  });
});
