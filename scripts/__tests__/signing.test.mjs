import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opensslVerifyArguments, signArguments, splitSignedBundle, verifySignedBundle } from "../lib/signing.mjs";

describe("signArguments", () => {
  it("passes certificate, key and optional intermediates to mcpb sign", () => {
    expect(
      signArguments("build/x.mcpb", {
        MCPB_SIGNING_CERT_FILE: "/tmp/cert.pem",
        MCPB_SIGNING_KEY_FILE: "/tmp/key.pem",
        MCPB_SIGNING_INTERMEDIATE_FILES: "/tmp/ca1.pem /tmp/ca2.pem",
      }),
    ).toEqual(["sign", "build/x.mcpb", "--cert", "/tmp/cert.pem", "--key", "/tmp/key.pem", "--intermediate", "/tmp/ca1.pem", "/tmp/ca2.pem"]);
  });

  it("never falls back to a throw-away self-signed certificate", () => {
    expect(() => signArguments("build/x.mcpb", { MCPB_SIGNING_CERT_FILE: "/tmp/cert.pem" })).toThrow(
      /MCPB_SIGNING_KEY_FILE is not set/,
    );
  });
});

/** The layout `mcpb sign` appends: "MCPB_SIG_V1" <uint32 LE length> <DER> "MCPB_SIG_END". */
function signedBundle(content, der) {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(der.length, 0);
  return Buffer.concat([content, Buffer.from("MCPB_SIG_V1"), length, der, Buffer.from("MCPB_SIG_END")]);
}

describe("splitSignedBundle", () => {
  it("separates the signed zip from the detached signature", () => {
    const zip = Buffer.from("PK\u0003\u0004 fake zip");
    const der = Buffer.from([0x30, 0x82, 0x01, 0x02]);
    const { content, signature } = splitSignedBundle(signedBundle(zip, der));
    expect(content.equals(zip)).toBe(true);
    expect(signature.equals(der)).toBe(true);
  });

  it("refuses unsigned or damaged bundles", () => {
    expect(() => splitSignedBundle(Buffer.from("PK unsigned"))).toThrow(/no signature block/);
    const damaged = signedBundle(Buffer.from("zip"), Buffer.from([1, 2, 3]));
    damaged.writeUInt32LE(99, 3 + "MCPB_SIG_V1".length);
    expect(() => splitSignedBundle(damaged)).toThrow(/damaged/);
  });
});

describe("opensslVerifyArguments", () => {
  it("checks the detached signature and pins the signer to the given certificate", () => {
    expect(opensslVerifyArguments({ signatureFile: "s.der", contentFile: "c.zip", trustFile: "t.pem", outFile: "o" })).toEqual([
      "cms", "-verify", "-binary", "-inform", "DER", "-in", "s.der", "-content", "c.zip",
      "-CAfile", "t.pem", "-partial_chain", "-purpose", "any", "-out", "o",
    ]);
  });
});

const hasOpenssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasOpenssl)("verifySignedBundle (real openssl)", () => {
  function makeCert(dir, name) {
    const key = join(dir, `${name}-key.pem`);
    const cert = join(dir, `${name}-cert.pem`);
    const r = spawnSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-subj", `/CN=${name}`],
      { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return { key, cert };
  }

  it("accepts the signing certificate and rejects any other", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-test-"));
    try {
      const signer = makeCert(dir, "inbox-warden test signer");
      const other = makeCert(dir, "someone else");
      const zip = join(dir, "bundle.zip");
      writeFileSync(zip, "PK fake bundle content");
      const der = join(dir, "sig.der");
      const s = spawnSync(
        "openssl",
        ["cms", "-sign", "-binary", "-in", zip, "-signer", signer.cert, "-inkey", signer.key, "-outform", "DER", "-out", der],
        { encoding: "utf8" },
      );
      expect(s.status, s.stderr).toBe(0);
      const bundle = join(dir, "bundle.mcpb");
      writeFileSync(bundle, signedBundle(readFileSync(zip), readFileSync(der)));

      expect(verifySignedBundle({ file: bundle, certFile: signer.cert })).toMatch(/inbox-warden test signer/);
      expect(() => verifySignedBundle({ file: bundle, certFile: other.cert })).toThrow(/Signature check failed/);

      const tampered = readFileSync(bundle);
      tampered[3] = tampered[3] ^ 0xff;
      writeFileSync(bundle, tampered);
      expect(() => verifySignedBundle({ file: bundle, certFile: signer.cert })).toThrow(/Signature check failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
