#!/usr/bin/env node
// Open every given bundle the way Claude Desktop does; exit 1 on the first one it would reject.
// Usage: node scripts/check-mcpb-zip.mjs <bundle.mcpb>…
import { openLikeClaudeDesktop } from "./lib/zip-check.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node scripts/check-mcpb-zip.mjs <bundle.mcpb>…");
  process.exit(2);
}
for (const file of files) {
  try {
    const { entries } = await openLikeClaudeDesktop(file);
    console.log(`ok   ${file} (${entries} entries)`);
  } catch (err) {
    console.error(`FAIL ${file}: ${err instanceof Error ? err.message : String(err)} — Claude Desktop cannot open this bundle.`);
    process.exit(1);
  }
}
