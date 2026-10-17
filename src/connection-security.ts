import { X509Certificate } from "node:crypto";
import type { ConnectionOptions, PeerCertificate } from "node:tls";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Local bridges (Proton Mail Bridge, DavMail) listen on loopback and may not offer STARTTLS. */
export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

const TLS_FLOOR: ConnectionOptions = { minVersion: "TLSv1.2" };

/** A self-signed server certificate the user explicitly chose to trust (spec D10). */
export interface TlsPin {
  /** "AB:CD:…" — the format of X509Certificate#fingerprint256 and PeerCertificate#fingerprint256. */
  fingerprint256: string;
  certificatePem: string;
}

export class CertificatePinMismatchError extends Error {
  readonly code = "ERR_CERT_PIN_MISMATCH";
  constructor(readonly expected: string, readonly actual: string) {
    super(
      `The mail server presented a different certificate than the one you trusted ` +
        `(expected ${expected}, got ${actual}). If you replaced the certificate on your server, run setup again to trust the new one; otherwise someone may be intercepting the connection.`,
    );
    this.name = "CertificatePinMismatchError";
  }
}

export function certificateFingerprint256(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

export function pinFromEndpoint(endpoint: { tlsFingerprint256?: string; tlsCertificatePem?: string }): TlsPin | undefined {
  if (!endpoint.tlsFingerprint256 || !endpoint.tlsCertificatePem) return undefined;
  return { fingerprint256: endpoint.tlsFingerprint256, certificatePem: endpoint.tlsCertificatePem };
}

/**
 * Trust exactly one certificate. Node calls checkServerIdentity only after the chain verified,
 * so the certificate itself is the only trust anchor (`ca`), and the fingerprint comparison
 * replaces the hostname check (self-signed certificates rarely carry the right name).
 * `allowPartialTrustChain` lets OpenSSL accept a non-self-signed anchor, so a leaf issued by a
 * private CA can be pinned too. Verification is never switched off.
 */
export function pinnedTlsOptions(pin: TlsPin): ConnectionOptions {
  return {
    ca: [pin.certificatePem],
    allowPartialTrustChain: true,
    checkServerIdentity: (_host: string, cert: PeerCertificate) =>
      cert.fingerprint256 === pin.fingerprint256 ? undefined : new CertificatePinMismatchError(pin.fingerprint256, cert.fingerprint256),
  };
}

/**
 * Implicit TLS on 993; on every other port STARTTLS is mandatory so a network attacker cannot
 * strip it and read the password. Loopback hosts keep imapflow's opportunistic default unless
 * a certificate is pinned (then TLS is required everywhere).
 */
export function imapSecurityOptions(
  host: string,
  port: number,
  pin?: TlsPin,
): { secure: boolean; doSTARTTLS?: true; tls: ConnectionOptions } {
  const secure = port === 993;
  const requireStartTls = !secure && (!isLoopback(host) || pin !== undefined);
  return {
    secure,
    ...(requireStartTls ? { doSTARTTLS: true as const } : {}),
    tls: { ...TLS_FLOOR, ...(pin ? pinnedTlsOptions(pin) : {}) },
  };
}

/** Implicit TLS on 465; STARTTLS required everywhere else except unpinned loopback. */
export function smtpSecurityOptions(
  host: string,
  port: number,
  pin?: TlsPin,
): { secure: boolean; requireTLS: boolean; tls: ConnectionOptions } {
  const secure = port === 465;
  return {
    secure,
    requireTLS: !secure && (!isLoopback(host) || pin !== undefined),
    tls: { ...TLS_FLOOR, ...(pin ? pinnedTlsOptions(pin) : {}) },
  };
}
