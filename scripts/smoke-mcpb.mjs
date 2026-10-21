#!/usr/bin/env node
// Start the staged bundle the way Claude Desktop does (node server/preflight.cjs serve) with the
// default form values and check what a first-time user gets.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeBinaries } from "./lib/mcpb.mjs";
import { inspectServer, offlineEnv } from "./lib/inspect-server.mjs";

const stage = resolve(process.argv[2] ?? "build/mcpb");
const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

check(
  nativeBinaries(readdirSync(join(stage, "node_modules"), { recursive: true, encoding: "utf8" })).length === 0,
  "no native binaries (one bundle for macOS and Windows)",
);
check(!existsSync(join(stage, "node_modules", "vitest")), "no dev dependencies in the bundle");

const home = mkdtempSync(join(tmpdir(), "mcpb-smoke-"));
try {
  const { tools, serverVersion } = await inspectServer({
    entry: join(stage, "server", "preflight.cjs"),
    env: offlineEnv(home, manifest.user_config.permissions.default),
  });
  const names = tools.map((tool) => tool.name);
  for (const expected of ["search_emails", "read_email", "create_draft", "reply_draft", "sign_in", "health_check"]) {
    check(names.includes(expected), `default permissions expose ${expected}`);
  }
  for (const hidden of ["send_email", "send_draft", "delete_email"]) {
    check(!names.includes(hidden), `default permissions hide ${hidden}`);
  }
  for (const tool of tools) {
    check(Boolean(tool.title), `${tool.name} has a title`);
  }
  if (serverVersion) {
    check(serverVersion.name === manifest.name && serverVersion.version === manifest.version, `server reports ${manifest.name} ${manifest.version}`);
  }

  // A setup problem (no hosts, autodetection off, unreachable domain) starts the setup-problem server.
  const broken = offlineEnv(home, manifest.user_config.permissions.default);
  delete broken.IMAP_MCP_IMAP_HOST;
  delete broken.IMAP_MCP_SMTP_HOST;
  broken.IMAP_MCP_EMAIL = "build@example.invalid";
  const problem = await inspectServer({ entry: join(stage, "server", "preflight.cjs"), env: broken });
  check(
    JSON.stringify(problem.tools.map((tool) => tool.name).sort()) === JSON.stringify(["health_check", "list_accounts"]),
    "a setup problem starts the setup-problem server",
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nSmoke test passed.");
