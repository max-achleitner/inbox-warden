import { describe, it, expect } from "vitest";
import { imapSecurityOptions, smtpSecurityOptions } from "../connection-security.js";

describe("connection security", () => {
  it("uses implicit TLS on 993 without STARTTLS", () => {
    expect(imapSecurityOptions("imap.example.com", 993)).toEqual({ secure: true, tls: { minVersion: "TLSv1.2" } });
  });

  it("requires STARTTLS on 143 so it cannot be downgraded to plaintext", () => {
    expect(imapSecurityOptions("mail.example.com", 143)).toMatchObject({ secure: false, doSTARTTLS: true });
  });

  it("allows opportunistic STARTTLS for loopback bridges", () => {
    expect(imapSecurityOptions("127.0.0.1", 1143).doSTARTTLS).toBeUndefined();
  });

  it("requires TLS for SMTP submission on 587", () => {
    expect(smtpSecurityOptions("smtp.office365.com", 587)).toMatchObject({ secure: false, requireTLS: true });
    expect(smtpSecurityOptions("smtp.example.com", 465)).toMatchObject({ secure: true, requireTLS: false });
  });
});
