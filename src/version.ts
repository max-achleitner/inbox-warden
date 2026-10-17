import { createRequire } from "node:module";

/**
 * Single source of truth for the product identity (owner decision O1). The MCP server, the CLI and
 * the IMAP ID command all use it. Renaming the product means changing SERVER_NAME and package.json
 * "name" together; src/__tests__/product-identity.test.ts fails while they differ.
 */
export const SERVER_NAME = "inbox-warden";

/** Where users find the documentation (README of the GitHub repository). */
export const DOCS_URL = "https://github.com/max-achleitner/inbox-warden#readme";

/** Start commands used before 1.0.0. They keep working (with a warning) until 2.0.0. */
export const LEGACY_COMMANDS = ["imap-mcp-server", "imap-mcp-setup"] as const;

// package.json sits one level above dist/ (npm install) and above server/ (MCPB bundle).
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;
