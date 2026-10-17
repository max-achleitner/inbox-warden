#!/usr/bin/env node
// Fails when a user-facing Markdown file links to a local file that does not exist.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { relativeLinks } from "./lib/links.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "build", "dist", ".git", "superpowers"]);

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return SKIP.has(entry) ? [] : markdownFiles(full);
    return entry.endsWith(".md") ? [full] : [];
  });
}

const files = [
  ...["README.md", "CHANGELOG.md", "PRIVACY.md", "SECURITY.md"].map((f) => join(root, f)).filter(existsSync),
  ...markdownFiles(join(root, "docs")),
  ...markdownFiles(join(root, "plugin")),
];
const broken = [];
for (const file of files) {
  for (const target of relativeLinks(readFileSync(file, "utf8"))) {
    if (!existsSync(resolve(dirname(file), target))) broken.push(`${relative(root, file)} → ${target}`);
  }
}
for (const line of broken) console.error(`broken link: ${line}`);
if (broken.length > 0) process.exit(1);
console.log(`Checked ${files.length} Markdown files: all local links resolve.`);
