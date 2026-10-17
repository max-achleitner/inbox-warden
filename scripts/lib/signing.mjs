import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Arguments for `mcpb sign`. Release bundles are always signed with the project's own certificate;
 * the CLI's --self-signed switch would create a fresh, unverifiable key on every run.
 */
export function signArguments(file, env) {
  for (const name of ["MCPB_SIGNING_CERT_FILE", "MCPB_SIGNING_KEY_FILE"]) {
    if (!env[name]) throw new Error(`${name} is not set — see docs/maintainers/release-signing.md`);
  }
  const args = ["sign", file, "--cert", env.MCPB_SIGNING_CERT_FILE, "--key", env.MCPB_SIGNING_KEY_FILE];
  const intermediates = (env.MCPB_SIGNING_INTERMEDIATE_FILES ?? "").split(/\s+/).filter(Boolean);
  if (intermediates.length > 0) args.push("--intermediate", ...intermediates);
  return args;
}

const SIGNATURE_HEADER = Buffer.from("MCPB_SIG_V1", "utf8");
const SIGNATURE_FOOTER = Buffer.from("MCPB_SIG_END", "utf8");

/**
 * Split a bundle signed by `mcpb sign` into the signed zip bytes and the detached PKCS#7 (DER)
 * signature. Layout: <zip> "MCPB_SIG_V1" <uint32 LE length> <DER> "MCPB_SIG_END".
 */
export function splitSignedBundle(bytes) {
  const footer = bytes.lastIndexOf(SIGNATURE_FOOTER);
  const header = footer < 0 ? -1 : bytes.lastIndexOf(SIGNATURE_HEADER, footer);
  if (footer < 0 || header < 0) throw new Error("The bundle carries no signature block.");
  const start = header + SIGNATURE_HEADER.length + 4;
  if (start > footer || start + bytes.readUInt32LE(header + SIGNATURE_HEADER.length) !== footer) {
    throw new Error("The signature block is damaged.");
  }
  return { content: bytes.subarray(0, header), signature: bytes.subarray(start, footer) };
}

/**
 * openssl arguments that check the detached signature against the content and accept only a
 * signer whose certificate is in `trustFile` (`-partial_chain` lets that certificate be the anchor).
 */
export function opensslVerifyArguments({ signatureFile, contentFile, trustFile, outFile }) {
  return [
    "cms", "-verify", "-binary", "-inform", "DER",
    "-in", signatureFile, "-content", contentFile,
    "-CAfile", trustFile, "-partial_chain", "-purpose", "any",
    "-out", outFile,
  ];
}

/**
 * Verify a signed bundle with openssl. `mcpb verify` (2.1.2) cannot do this: node-forge's PKCS#7
 * verify() is not implemented, so it reports every bundle as "not signed".
 * Throws with openssl's message when the signature does not match the bundle or the certificate.
 */
export function verifySignedBundle({ file, certFile, intermediateFiles = [], openssl = "openssl" }) {
  const { content, signature } = splitSignedBundle(readFileSync(file));
  const work = mkdtempSync(join(tmpdir(), "mcpb-verify-"));
  try {
    const files = {
      signatureFile: join(work, "signature.der"),
      contentFile: join(work, "content.zip"),
      trustFile: join(work, "trust.pem"),
      outFile: join(work, "verified.out"),
    };
    writeFileSync(files.signatureFile, signature);
    writeFileSync(files.contentFile, content);
    writeFileSync(files.trustFile, [certFile, ...intermediateFiles].map((f) => readFileSync(f, "utf8")).join("\n"));
    const result = spawnSync(openssl, opensslVerifyArguments(files), { encoding: "utf8" });
    if (result.error) throw new Error(`openssl could not be started: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Signature check failed: ${(result.stderr || "").trim()}`);
    const info = spawnSync(openssl, ["x509", "-in", certFile, "-noout", "-subject", "-fingerprint", "-sha256"], { encoding: "utf8" });
    return info.stdout.trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
