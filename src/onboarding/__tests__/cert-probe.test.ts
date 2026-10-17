import { describe, it, expect, beforeAll } from "vitest";
import { ProbeError, probeCertificate } from "../cert-probe.js";
import {
  selfSignedCert,
  startStartTlsServer,
  startTlsServer,
  type SelfSignedCert,
} from "../../__tests__/helpers/tls-fixtures.js";

describe("probeCertificate", () => {
  let cert: SelfSignedCert;

  beforeAll(async () => {
    cert = await selfSignedCert("mail.selfhosted.test");
  });

  it("reads the certificate of an implicit-TLS server and reports it as untrusted", async () => {
    const server = await startTlsServer(cert);
    try {
      const info = await probeCertificate({ host: "127.0.0.1", port: server.port, protocol: "imap", security: "implicit" });
      expect(info.fingerprint256).toBe(cert.fingerprint256);
      expect(info.pem).toContain("-----BEGIN CERTIFICATE-----");
      expect(info.subject).toContain("CN=mail.selfhosted.test");
      expect(info.selfSigned).toBe(true);
      expect(info.trusted).toBe(false);
      expect(info.trustError).toMatch(/SELF_SIGNED/);
      expect(info.hostnameMatches).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("upgrades an IMAP connection with STARTTLS", async () => {
    const server = await startStartTlsServer(cert, "imap");
    try {
      const info = await probeCertificate({ host: "127.0.0.1", port: server.port, protocol: "imap", security: "starttls" });
      expect(info.fingerprint256).toBe(cert.fingerprint256);
    } finally {
      await server.close();
    }
  });

  it("upgrades an SMTP connection with EHLO + STARTTLS", async () => {
    const server = await startStartTlsServer(cert, "smtp");
    try {
      const info = await probeCertificate({ host: "127.0.0.1", port: server.port, protocol: "smtp", security: "starttls" });
      expect(info.fingerprint256).toBe(cert.fingerprint256);
    } finally {
      await server.close();
    }
  });

  it("explains when the server offers no STARTTLS", async () => {
    const server = await startStartTlsServer(cert, "smtp", { offerStartTls: false });
    try {
      await expect(
        probeCertificate({ host: "127.0.0.1", port: server.port, protocol: "smtp", security: "starttls" }),
      ).rejects.toThrow(/does not offer STARTTLS/);
    } finally {
      await server.close();
    }
  });

  it("times out on a silent server", async () => {
    const { createServer } = await import("node:net");
    const silent = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as { port: number }).port;
    try {
      await expect(
        probeCertificate({ host: "127.0.0.1", port, protocol: "imap", security: "starttls", timeoutMs: 200 }),
      ).rejects.toBeInstanceOf(ProbeError);
    } finally {
      silent.close();
    }
  });
});
