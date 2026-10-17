import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleUrl, syncVersions, versionProblems } from "../lib/versions.mjs";

function fixture(pkgVersion, pluginVersion, urlVersion) {
  const root = mkdtempSync(join(tmpdir(), "versions-"));
  mkdirSync(join(root, "plugin", ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "inbox-warden", version: pkgVersion }));
  writeFileSync(
    join(root, "plugin", ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "inbox-warden", version: pluginVersion, mcpServers: bundleUrl("inbox-warden", urlVersion) }),
  );
  return root;
}

describe("versions", () => {
  it("builds the release asset URL", () => {
    expect(bundleUrl("inbox-warden", "1.0.0")).toBe(
      "https://github.com/max-achleitner/inbox-warden/releases/download/v1.0.0/inbox-warden-1.0.0.mcpb",
    );
  });

  it("reports nothing when everything matches", () => {
    expect(versionProblems(fixture("1.0.0", "1.0.0", "1.0.0"))).toEqual([]);
  });

  it("reports a stale plugin version and bundle URL", () => {
    expect(versionProblems(fixture("1.0.1", "1.0.0", "1.0.0"))).toEqual([
      "plugin/.claude-plugin/plugin.json version is 1.0.0, expected 1.0.1",
      "plugin/.claude-plugin/plugin.json mcpServers points at 1.0.0, expected " + bundleUrl("inbox-warden", "1.0.1"),
    ]);
  });

  it("syncVersions fixes both fields and keeps everything else", () => {
    const root = fixture("1.1.0", "1.0.0", "1.0.0");
    syncVersions(root);
    expect(versionProblems(root)).toEqual([]);
    const plugin = JSON.parse(readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
    expect(plugin.name).toBe("inbox-warden");
  });
});
