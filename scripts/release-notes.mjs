#!/usr/bin/env node
// Usage: node scripts/release-notes.mjs 1.0.0 > notes.md
import { readFileSync } from "node:fs";
import { extractReleaseNotes } from "./lib/release-notes.mjs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}
process.stdout.write(extractReleaseNotes(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), version) + "\n");
