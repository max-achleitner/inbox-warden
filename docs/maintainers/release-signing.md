# Signing the Claude Desktop extension

Release bundles (`.mcpb`) are signed so that administrators can enforce
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
