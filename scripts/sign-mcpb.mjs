#!/usr/bin/env node
// Usage: MCPB_SIGNING_CERT_FILE=… MCPB_SIGNING_KEY_FILE=… npm run sign:mcpb -- build/inbox-warden-1.0.0.mcpb
import { spawnSync } from "node:child_process";
import { signArguments, verifySignedBundle } from "./lib/signing.mjs";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const file = process.argv[2];
const npmCli = process.env.npm_execpath; // set by "npm run"; avoids the npm.cmd shell shim on Windows
if (!file || !npmCli) {
  console.error("Usage: npm run sign:mcpb -- <bundle.mcpb>");
  process.exit(2);
}

const sign = spawnSync(
  process.execPath,
  [npmCli, "exec", "--yes", `--package=${MCPB_CLI}`, "--", "mcpb", ...signArguments(file, process.env)],
  { stdio: "inherit" },
);
if (sign.status !== 0) process.exit(sign.status ?? 1);

// Not `mcpb verify`: in 2.1.2 it reports every bundle as unsigned (see lib/signing.mjs).
try {
  const signer = verifySignedBundle({
    file,
    certFile: process.env.MCPB_SIGNING_CERT_FILE,
    intermediateFiles: (process.env.MCPB_SIGNING_INTERMEDIATE_FILES ?? "").split(/\s+/).filter(Boolean),
  });
  console.log(`Signature verified with openssl:\n${signer}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
