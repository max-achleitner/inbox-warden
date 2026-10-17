import { describe, it, expect, beforeAll } from "vitest";
import { ConfigSchema, EndpointSchema, pinProblem } from "../schema.js";
import { selfSignedCert, type SelfSignedCert } from "../../__tests__/helpers/tls-fixtures.js";

function config(imap: Record<string, unknown>) {
  return { version: 2, accounts: [{ id: "main", email: "max@firma.example", imap: { host: "mail.x", port: 993, ...imap } }] };
}

describe("certificate pin in the configuration", () => {
  let cert: SelfSignedCert;
  beforeAll(async () => {
    cert = await selfSignedCert();
  });

  it("accepts a matching fingerprint and certificate", () => {
    expect(ConfigSchema.safeParse(config({ tlsFingerprint256: cert.fingerprint256, tlsCertificatePem: cert.cert })).success).toBe(true);
  });

  it("rejects a fingerprint without certificate and vice versa", () => {
    expect(ConfigSchema.safeParse(config({ tlsFingerprint256: cert.fingerprint256 })).success).toBe(false);
    expect(ConfigSchema.safeParse(config({ tlsCertificatePem: cert.cert })).success).toBe(false);
  });

  it("rejects a fingerprint that does not belong to the certificate", async () => {
    const other = await selfSignedCert();
    const result = ConfigSchema.safeParse(config({ tlsFingerprint256: other.fingerprint256, tlsCertificatePem: cert.cert }));
    expect(result.success).toBe(false);
    expect(pinProblem({ tlsFingerprint256: other.fingerprint256, tlsCertificatePem: cert.cert })).toMatch(/does not match/);
  });

  it("keeps endpoints without a pin valid and EndpointSchema extendable", () => {
    expect(ConfigSchema.safeParse(config({})).success).toBe(true);
    expect(() => EndpointSchema.extend({ note: EndpointSchema.shape.host.optional() })).not.toThrow();
  });
});
