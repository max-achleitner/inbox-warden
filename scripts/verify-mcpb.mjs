#!/usr/bin/env node
// Check that a downloaded bundle was signed with the published release certificate.
// Usage: node scripts/verify-mcpb.mjs <bundle.mcpb> <signing-cert.pem> [intermediate.pem …]
import { verifySignedBundle } from "./lib/signing.mjs";

const [file, certFile, ...intermediateFiles] = process.argv.slice(2);
if (!file || !certFile) {
  console.error("Usage: node scripts/verify-mcpb.mjs <bundle.mcpb> <signing-cert.pem> [intermediate.pem …]");
  process.exit(2);
}
try {
  console.log(`Signature verified with openssl:\n${verifySignedBundle({ file, certFile, intermediateFiles })}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
