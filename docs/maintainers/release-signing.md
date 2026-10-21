# Signing the Claude Desktop extension

## Paused since 0.7.0

From 0.7.0 on the release bundle (`.mcpb`) is **not signed**. Two reasons:

1. `mcpb sign` 2.1.2 appends the signature block (`MCPB_SIG_V1 … MCPB_SIG_END`) after the ZIP end-of-central-directory
   record and leaves the ZIP comment length at 0. Claude Desktop 3.1623 opens the whole file with yauzl 3's strict
   check and fails with "Invalid comment length. Expected: 1872. Found: 0", so the signed 0.6.0 bundle cannot be
   installed.
2. Desktop's PKCS#7 check (node-forge `verify()`) always throws "PKCS#7 signature verification not yet
   implemented", so Desktop never shows an extension as signed anyway.

The origin of a bundle is proven by `SHA256SUMS` and the GitHub build attestation. CI opens every built and
released bundle the way Desktop does (`npm run check:mcpb-zip -- <file>`).

Resume signing only when both hold: a Claude Desktop version whose extension check really verifies PKCS#7 (look in
its `app.asar` for node-forge's "PKCS#7 signature verification not yet implemented"; it must be gone) and a bundle
layout that Desktop's ZIP reader accepts (`check:mcpb-zip` passes on the signed file). Everything below is kept as
reference for that day and for verifying 0.6.0.

---

Release bundles (`.mcpb`) up to 0.6.0 were signed so that administrators can enforce
`isDesktopExtensionSignatureRequired` and users can check who published a bundle.

**Do not rely on `mcpb verify` (2.1.2):** it reports every bundle as "not signed", because node-forge's
PKCS#7 `verify()` is not implemented (it always throws; mcpb maps that to "unsigned"). The signature
itself is fine. Check it with openssl instead:

```bash
node scripts/verify-mcpb.mjs inbox-warden-<version>.mcpb mcpb-signing-cert.pem [intermediate.pem …]
```

It splits the signature block that `mcpb sign` appends (`MCPB_SIG_V1` <length> <PKCS#7 DER> `MCPB_SIG_END`),
checks the detached signature over the bundle with `openssl cms -verify`, and accepts only the given
certificate as signer. Output: `Signature verified with openssl:` plus subject and SHA-256 fingerprint.

## Certificate

Preferred: an **organisation-validated (OV) code-signing certificate** from a public CA, exported as
PEM (`cert.pem`), private key (`key.pem`) and the CA's intermediate certificate(s).

Until one is available, use a dedicated long-lived self-signed certificate and publish its
fingerprint in the README so administrators can pin it:

```bash
openssl req -x509 -newkey rsa:3072 -sha256 -days 730 -nodes \
  -keyout mcpb-signing-key.pem -out mcpb-signing-cert.pem \
  -subj "/CN=inbox-warden release signing/O=Max Achleitner" \
  -addext "extendedKeyUsage=codeSigning" -addext "keyUsage=digitalSignature"
openssl x509 -in mcpb-signing-cert.pem -noout -fingerprint -sha256
```

Keep `mcpb-signing-key.pem` offline (password manager or hardware token export); never commit it.

## GitHub secrets (Settings → Secrets and variables → Actions, environment `release`)

| Secret | Content |
|---|---|
| `MCPB_SIGNING_CERT_PEM` | full text of the certificate PEM |
| `MCPB_SIGNING_KEY_PEM` | full text of the private key PEM |
| `MCPB_SIGNING_INTERMEDIATE_PEM` | intermediate certificate(s) PEM; leave unset for self-signed |

The release workflow writes them to files under `$RUNNER_TEMP`, signs, verifies, and deletes the files.

## Local signing

```bash
MCPB_SIGNING_CERT_FILE=./mcpb-signing-cert.pem MCPB_SIGNING_KEY_FILE=./mcpb-signing-key.pem \
  npm run sign:mcpb -- build/inbox-warden-1.0.0.mcpb
```

Expected end of output: `Successfully signed …`, then `Signature verified with openssl:` with the certificate's
`subject=…` and `SHA256 Fingerprint=…` (the script runs the same check as `scripts/verify-mcpb.mjs`).

Whether Claude Desktop accepts the signature under `isDesktopExtensionSignatureRequired` (CA-issued vs.
self-signed) is not documented; check it once in the 1.0.0 acceptance (`docs/maintainers/acceptance-1.0.md`).

## Rotation

Create the new certificate before the old one expires, publish both fingerprints in the README for one
release, then remove the old one. Record the change in `CHANGELOG.md` under "Security".
