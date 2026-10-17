import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigSchema } from "../schema.js";
import { filesFromEnv, loadConfig } from "../load.js";

const minimal = {
  version: 2,
  accounts: [{ id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } }],
};

describe("files configuration", () => {
  it("defaults to no folders, 100 KiB of text and 1 MiB images inline", () => {
    expect(ConfigSchema.parse(minimal).files).toEqual({
      attachmentDirs: [],
      maxInlineTextBytes: 100 * 1024,
      maxInlineImageBytes: 1024 * 1024,
    });
  });

  it("caps the inline limits", () => {
    expect(ConfigSchema.safeParse({ ...minimal, files: { maxInlineTextBytes: 2 * 1024 * 1024 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...minimal, files: { maxInlineImageBytes: 50 * 1024 * 1024 } }).success).toBe(false);
  });

  it("reads folders from the environment (MCPB bundles, containers)", () => {
    const env = {
      IMAP_MCP_ATTACHMENT_DIRS: ["/data/angebote", "/data/rechnungen", ""].join(path.delimiter),
      IMAP_MCP_DOWNLOAD_DIR: "/data/downloads",
    };
    expect(filesFromEnv(env)).toEqual({ attachmentDirs: ["/data/angebote", "/data/rechnungen"], downloadDir: "/data/downloads" });
    expect(filesFromEnv({})).toEqual({});
  });

  it("applies the environment in env-only mode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "imap-mcp-home-"));
    try {
      const config = await loadConfig({
        IMAP_MCP_HOME: home,
        IMAP_MCP_EMAIL: "max@firma.example",
        IMAP_MCP_IMAP_HOST: "mail.firma.example",
        IMAP_MCP_PASSWORD: "secret",
        IMAP_MCP_DOWNLOAD_DIR: path.join(home, "dl"),
      });
      expect(config.files.downloadDir).toBe(path.join(home, "dl"));
      expect(config.files.attachmentDirs).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
