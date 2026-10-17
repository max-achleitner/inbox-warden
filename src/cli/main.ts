#!/usr/bin/env node
// Pre-1.0 setup command (`imap-mcp-setup`, `node dist/cli/main.js …` in older docs). Kept until 2.0.0.
// The admin commands live in ./run.ts (runCli); new code calls them through ./program.ts.
import { runLegacy } from "./program.js";

await runLegacy("setup", process.argv.slice(2));
