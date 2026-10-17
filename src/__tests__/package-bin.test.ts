import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("package entry points", () => {
  it("exposes one command plus the pre-1.0 aliases", () => {
    expect(pkg.bin).toEqual({
      "inbox-warden": "dist/bin.js",
      "imap-mcp-server": "dist/index.js",
      "imap-mcp-setup": "dist/cli/main.js",
    });
  });

  it("keeps the pre-1.0 entry points as shims, not as copies of the server or the CLI", () => {
    expect(readFileSync(join(root, "src", "index.ts"), "utf8")).toContain('runLegacy("serve"');
    expect(readFileSync(join(root, "src", "cli", "main.ts"), "utf8")).toContain('runLegacy("setup"');
  });

  it("every bin source starts with a node shebang", () => {
    for (const target of Object.values(pkg.bin) as string[]) {
      const source = join(root, target.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
      expect(readFileSync(source, "utf8").split(/\r?\n/)[0]).toBe("#!/usr/bin/env node");
    }
  });

  it("npm scripts use the new entry point", () => {
    expect(pkg.scripts.start).toBe("node dist/bin.js serve");
    expect(pkg.scripts.setup).toBe("node dist/bin.js setup");
    expect(pkg.scripts.doctor).toBe("node dist/bin.js doctor");
    expect(pkg.main).toBe("dist/server.js");
    // scripts go through the dispatcher; dist/cli/main.js is only the pre-1.0 shim
    expect(Object.values(pkg.scripts).filter((cmd) => String(cmd).includes("dist/cli/main.js"))).toEqual([]);
  });
});
