import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthProvider } from "../auth/provider.js";

const connectAttempts: Array<Record<string, unknown>> = [];
let failure: Error | null = null;

vi.mock("imapflow", () => ({
  ImapFlow: class {
    usable = true;
    constructor(readonly options: Record<string, unknown>) {
      connectAttempts.push(options);
    }
    on() {}
    async connect() {
      if (failure) throw failure;
    }
    async logout() {}
    close() {}
    async noop() {}
  },
}));

const { ImapConnectionManager } = await import("../imap-client.js");
const { OAuthConfigurationError, OAuthReauthRequiredError, OAuthSignInRequiredError } = await import("../auth/oauth/errors.js");
const { MissingPasswordError } = await import("../auth/provider.js");
const { CertificatePinMismatchError } = await import("../connection-security.js");

function authFailure(): Error {
  return Object.assign(new Error("Authentication failed"), { authenticationFailed: true });
}

describe("ImapConnectionManager", () => {
  let invalidations: number;
  let auth: AuthProvider;

  beforeEach(() => {
    connectAttempts.length = 0;
    failure = null;
    invalidations = 0;
    auth = {
      imapAuth: async () => ({ user: "max@firma.example", pass: "pw" }),
      smtpAuth: async () => ({ user: "max@firma.example", pass: "pw" }),
      invalidate: async () => { invalidations++; },
    };
  });

  it("requires STARTTLS on port 143 and passes the credentials from the auth provider", async () => {
    const manager = new ImapConnectionManager({ host: "mail.firma.example", port: 143 }, auth, "main");
    await manager.getClient();
    expect(connectAttempts[0]).toMatchObject({
      host: "mail.firma.example",
      port: 143,
      secure: false,
      doSTARTTLS: true,
      auth: { user: "max@firma.example", pass: "pw" },
    });
  });

  it("stops after a second rejected login instead of retrying five times (avoids account lockouts)", async () => {
    failure = authFailure();
    const manager = new ImapConnectionManager({ host: "mail.firma.example", port: 993 }, auth, "main");
    await expect(manager.getClient()).rejects.toThrow(/Login to mail\.firma.example was rejected.*app password/);
    expect(connectAttempts).toHaveLength(2);
    expect(invalidations).toBe(2);
  });

  describe("failures another attempt cannot fix are not retried", () => {
    it.each([
      ["a revoked OAuth sign-in", () => new OAuthReauthRequiredError("main", "invalid_grant")],
      ["a missing OAuth sign-in", () => new OAuthSignInRequiredError("main")],
      ["an OAuth configuration error", () => new OAuthConfigurationError("No client id configured")],
      ["a missing password", () => new MissingPasswordError("main")],
    ])("%s", async (_name, makeError) => {
      let authCalls = 0;
      auth.imapAuth = async () => {
        authCalls++;
        throw makeError();
      };
      const manager = new ImapConnectionManager({ host: "mail.firma.example", port: 993 }, auth, "main");
      await expect(manager.getClient()).rejects.toBeInstanceOf(makeError().constructor);
      expect(authCalls).toBe(1);
    });

    it("a certificate pin mismatch (possible interception)", async () => {
      failure = new CertificatePinMismatchError("AA:BB", "CC:DD");
      const manager = new ImapConnectionManager({ host: "mail.firma.example", port: 993 }, auth, "main");
      await expect(manager.getClient()).rejects.toThrow(/different certificate than the one you trusted/);
      expect(connectAttempts).toHaveLength(1);
    });

    it("an untrusted certificate", async () => {
      failure = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
      const manager = new ImapConnectionManager({ host: "mail.firma.example", port: 993 }, auth, "main");
      await expect(manager.getClient()).rejects.toThrow(/self-signed certificate/);
      expect(connectAttempts).toHaveLength(1);
    });
  });

  it("still retries network failures with backoff", async () => {
    vi.useFakeTimers();
    try {
      failure = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      const manager = new ImapConnectionManager({ host: "mail.firma.example", port: 993 }, auth, "main");
      const attempt = manager.getClient();
      const assertion = expect(attempt).rejects.toThrow(/after 5 attempts/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(connectAttempts).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
