#!/usr/bin/env node
// Pre-1.0 entry point (`node dist/index.js`, `imap-mcp-server`). Kept until 2.0.0.
import { runLegacy } from "./cli/program.js";

await runLegacy("serve", process.argv.slice(2));
