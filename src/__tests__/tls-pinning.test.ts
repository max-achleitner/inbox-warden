import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect } from "node:tls";
import {
  CertificatePinMismatchError,
  certificateFingerprint256,
  imapSecurityOptions,
  pinFromEndpoint,
  pinnedTlsOptions,
  smtpSecurityOptions,
  type TlsPin,
} from "../connection-security.js";
import { caSignedCert, selfSignedCert, startTlsServer, type RunningServer, type SelfSignedCert } from "./helpers/tls-fixtures.js";

function handshake(port: number, options: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, ...options }, () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });
}

describe("certificate pinning", () => {
  let cert: SelfSignedCert;
  let server: RunningServer;
  let pin: TlsPin;

  beforeAll(async () => {
    cert = await selfSignedCert();
    server = await startTlsServer(cert);
    pin = { fingerprint256: cert.fingerprint256, certificatePem: cert.cert };
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects the self-signed certificate without a pin", async () => {
    await expect(handshake(server.port, { minVersion: "TLSv1.2" })).rejects.toThrow(/self[- ]signed/i);
  });

  it("accepts it when pinned, even though the hostname (127.0.0.1) does not match", async () => {
    await expect(handshake(server.port, pinnedTlsOptions(pin))).resolves.toBeUndefined();
  });

  it("rejects a different certificate under the same pin", async () => {
    const other = await selfSignedCert();
    const otherServer = await startTlsServer(other);
    try {
      // the other cert is not the trust anchor, so the chain check already fails
      await expect(handshake(otherServer.port, pinnedTlsOptions(pin))).rejects.toThrow();
    } finally {
      await otherServer.close();
    }
  });

  it("fails with a plain-language error when the fingerprint does not match a trusted cert", async () => {
    const wrongPin = { fingerprint256: "00:" + cert.fingerprint256.slice(3), certificatePem: cert.cert };
    await expect(handshake(server.port, pinnedTlsOptions(wrongPin))).rejects.toBeInstanceOf(CertificatePinMismatchError);
  });

  describe("a certificate issued by a private CA", () => {
    let leaf: Awaited<ReturnType<typeof caSignedCert>>;
    let caServer: RunningServer;

    beforeAll(async () => {
      leaf = await caSignedCert();
      caServer = await startTlsServer(leaf);
    });

    afterAll(async () => {
      await caServer.close();
    });

    it("is rejected without a pin (issuer unknown)", async () => {
      await expect(handshake(caServer.port, { minVersion: "TLSv1.2" })).rejects.toThrow();
    });

    it("is accepted when the leaf itself is pinned", async () => {
      const leafPin = { fingerprint256: leaf.fingerprint256, certificatePem: leaf.cert };
      await expect(handshake(caServer.port, pinnedTlsOptions(leafPin))).resolves.toBeUndefined();
    });

    it("does not trust other certificates from the same CA", async () => {
      const sibling = await caSignedCert("mail.company.test", leaf.ca);
      const leafPin = { fingerprint256: leaf.fingerprint256, certificatePem: leaf.cert };
      // the server even sends the full chain; only the pinned leaf is an anchor
      const siblingServer = await startTlsServer({ ...sibling, cert: `${sibling.cert.trim()}\n${leaf.ca.cert.trim()}\n` });
      try {
        await expect(handshake(siblingServer.port, pinnedTlsOptions(leafPin))).rejects.toThrow();
      } finally {
        await siblingServer.close();
      }
    });
  });

  it("computes fingerprints in Node's AB:CD:… format", () => {
    expect(certificateFingerprint256(cert.cert)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});

describe("security options with a pin", () => {
  const pin: TlsPin = { fingerprint256: "AA", certificatePem: "-----BEGIN CERTIFICATE-----" };

  it("requires STARTTLS on loopback when a pin is set (Proton Mail Bridge)", () => {
    expect(imapSecurityOptions("127.0.0.1", 1143, pin)).toMatchObject({ secure: false, doSTARTTLS: true });
    expect(imapSecurityOptions("127.0.0.1", 1143).doSTARTTLS).toBeUndefined();
    expect(smtpSecurityOptions("127.0.0.1", 1025, pin).requireTLS).toBe(true);
  });

  it("adds the pin to the TLS options and keeps the TLS 1.2 floor", () => {
    const tls = imapSecurityOptions("mail.example.com", 993, pin).tls;
    expect(tls.minVersion).toBe("TLSv1.2");
    expect(tls.ca).toEqual([pin.certificatePem]);
    expect(typeof tls.checkServerIdentity).toBe("function");
  });

  it("builds a pin only when both fingerprint and certificate are configured", () => {
    expect(pinFromEndpoint({ tlsFingerprint256: "AA" })).toBeUndefined();
    expect(pinFromEndpoint({ tlsFingerprint256: "AA", tlsCertificatePem: "P" })).toEqual({ fingerprint256: "AA", certificatePem: "P" });
  });
});
