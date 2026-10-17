#!/usr/bin/env node
// Build the Claude Desktop extension from the compiled dist/ folder.
//   npm run build && npm run build:mcpb            → build/inbox-warden-<version>.mcpb
//   npm run build:mcpb -- --skip-pack              → staging folder only (build/mcpb)
// Runs on Linux, macOS and Windows; CI builds release bundles on Linux.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleFileName, nativeBinaries, renderManifest, toolSummaries } from "./lib/mcpb.mjs";
import { inspectServer, offlineEnv } from "./lib/inspect-server.mjs";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const MAX_BUNDLE_BYTES = 80 * 1024 * 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "build", "mcpb");

// Call npm through node + npm-cli.js (set by "npm run") instead of the npm.cmd shim: no shell is
// involved, so paths with spaces (C:\Users\Max Müller\…\Temp) reach npm intact on Windows too.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script through npm: "npm run build:mcpb".');

function run(command, args, { cwd = root, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status})`);
  return result.stdout;
}
const npm = (args, options) => run(process.execPath, [npmCli, ...args], options);
const mcpb = (args) => npm(["exec", "--yes", `--package=${MCPB_CLI}`, "--", "mcpb", ...args]);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!existsSync(join(root, "dist", "bin.js"))) throw new Error('dist/bin.js is missing — run "npm run build" first.');

console.log(`Staging ${pkg.name} ${pkg.version} in build/mcpb …`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. Compiled server and the Node-version preflight shim
cpSync(join(root, "dist"), join(stage, "server"), {
  recursive: true,
  filter: (source) => !/\.(map|d\.ts)$/.test(source),
});
copyFileSync(join(root, "scripts", "templates", "preflight.cjs"), join(stage, "server", "preflight.cjs"));

// 2. Exactly the locked production dependencies, without install scripts
copyFileSync(join(root, "package.json"), join(stage, "package.json"));
copyFileSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
npm(["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage });

// 3. One bundle for macOS and Windows: no compiled modules. --omit=optional drops platform packages
//    (e.g. @napi-rs/keyring-*), --ignore-scripts skips native builds (e.g. a leftover keytar).
const native = nativeBinaries(readdirSync(join(stage, "node_modules"), { recursive: true, encoding: "utf8" }));
if (native.length > 0) {
  throw new Error(`Native binaries would tie the bundle to one platform:\n  ${native.join("\n  ")}`);
}

// 4. Documents shipped inside the bundle
for (const file of ["LICENSE", "PRIVACY.md", "README.md"]) copyFileSync(join(root, file), join(stage, file));

// 5. Manifest: version from package.json, tool list from the staged server itself
const home = mkdtempSync(join(tmpdir(), "mcpb-home-"));
const { tools } = await inspectServer({
  entry: join(stage, "server", "preflight.cjs"),
  env: offlineEnv(home, "read,write,send,delete"),
});
rmSync(home, { recursive: true, force: true });
const template = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
const manifest = renderManifest(template, pkg, toolSummaries(tools));
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`  manifest: ${manifest.tools.length} tools`);

mcpb(["validate", join(stage, "manifest.json")]);

// 6. Pack
if (!process.argv.includes("--skip-pack")) {
  const output = join(root, "build", bundleFileName(pkg.name, pkg.version));
  mcpb(["pack", stage, output]);
  const size = statSync(output).size;
  if (size > MAX_BUNDLE_BYTES) throw new Error(`Bundle is ${(size / 1048576).toFixed(1)} MB — over the 80 MB sanity limit.`);
  console.log(`Bundle: ${output} (${(size / 1048576).toFixed(1)} MB)`);
}
