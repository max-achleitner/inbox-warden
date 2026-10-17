import { describe, it, expect, vi, afterEach } from "vitest";
import { redactImapLine, redactLogData } from "../redact.js";
import { createProtocolLogger } from "../protocol-log.js";
import * as log from "../logger.js";

describe("log redaction", () => {
  it("redacts secret-like keys and omits message content", () => {
    expect(
      redactLogData({ password: "pw", accessToken: "t", subject: "Gehalt", body: "x", to: "a@x.com", nested: { clientSecret: "s" } }),
    ).toEqual({ password: "[REDACTED]", accessToken: "[REDACTED]", subject: "[omitted]", body: "[omitted]", to: "a@x.com", nested: { clientSecret: "[REDACTED]" } });
  });

  it("redacts bearer tokens inside strings", () => {
    expect(redactLogData({ header: "Authorization: Bearer eyJhbGciOi.abc" }).header).toBe("Authorization: Bearer [REDACTED]");
  });

  it.each([
    ["c", "3 LOGIN max@firma.example hunter2", "3 LOGIN [REDACTED]"],
    ["c", "4 AUTHENTICATE PLAIN AG1heEBmaXJtYS5leGFtcGxlAGh1bnRlcjI=", "4 AUTHENTICATE PLAIN [REDACTED]"],
    ["c", "5 AUTHENTICATE XOAUTH2 dXNlcj1tYXhAZmlybWEuZXhhbXBsZQFhdXRoPUJlYXJlciB5eXkBAQ==", "5 AUTHENTICATE XOAUTH2 [REDACTED]"],
    ["c", "6 AUTHENTICATE PLAIN", "6 AUTHENTICATE PLAIN"],
    ["c", "AG1heEBmaXJtYS5leGFtcGxlAGh1bnRlcjI=", "[REDACTED]"],
    ["s", "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready", "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready"],
  ])("redacts IMAP line from %s: %s", (src, line, expected) => {
    expect(redactImapLine(src, line)).toBe(expected);
  });
});

describe("protocol logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is disabled unless IMAP_MCP_PROTOCOL_LOG=1", () => {
    expect(createProtocolLogger({})).toBe(false);
  });

  it("never emits credentials", () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const logger = createProtocolLogger({ IMAP_MCP_PROTOCOL_LOG: "1" });
    if (!logger) throw new Error("expected a logger");
    logger.debug({ src: "c", msg: "4 AUTHENTICATE PLAIN AG1heEBmaXJtYS5leGFtcGxlAGh1bnRlcjI=", cid: "x" });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/AG1heE/);
  });
});
