#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { versionProblems } from "./lib/versions.mjs";

const problems = versionProblems(fileURLToPath(new URL("..", import.meta.url)));
for (const problem of problems) console.error(`version mismatch: ${problem}`);
if (problems.length > 0) {
  console.error('Run "node scripts/sync-versions.mjs" (npm version runs it automatically).');
  process.exit(1);
}
console.log("Versions are in sync.");
