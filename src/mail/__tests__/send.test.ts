import { describe, it, expect, beforeEach } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { createCaptureTransport, type CaptureTransport } from "../../__tests__/helpers/capture-transport.js";
import { header } from "../../__tests__/helpers/messages.js";
import { composeMessage } from "../compose.js";
import { deliver, type SendDeps } from "../send.js";

describe("deliver", () => {
  let imap: FakeImap;
  let capture: CaptureTransport;
  let deps: SendDeps;

  beforeEach(() => {
    imap = new FakeImap();
    imap.addFolder("Sent", { specialUse: "\\Sent" });
    capture = createCaptureTransport();
    deps = {
      transport: capture.transport,
      getClient: async () => imap.asClient(),
      imapHost: "mail.example.com",
      sentCopy: "auto",
      sentProbeCache: new Map(),
      sentProbe: { attempts: 1, delayMs: 0 },
    };
  });

  async function message() {
    return composeMessage({ from: "max@example.com", to: "kunde@example.com", bcc: "chef@example.com", subject: "Hi", text: "Hallo" });
  }

  it("transmits without Bcc header but to all envelope recipients, and archives with Bcc", async () => {
    const m = await message();
    const result = await deliver(deps, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });

    expect(capture.sent).toHaveLength(1);
    expect(header(capture.sent[0].raw, "bcc")).toBeUndefined();
    expect(capture.sent[0].envelope.to).toEqual(["kunde@example.com", "chef@example.com"]);

    expect(result.sentCopy).toMatchObject({ saved: true, folder: "Sent" });
    const stored = imap.message("Sent", result.sentCopy.uid!)!;
    expect(header(stored.raw, "bcc")).toBe("chef@example.com");
    expect(stored.flags.has("\\Seen")).toBe(true);
  });

  it("does not append for Gmail (server files sent mail itself)", async () => {
    imap.capabilities.set("X-GM-EXT-1", true);
    const m = await message();
    const result = await deliver(deps, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });
    expect(result.sentCopy.saved).toBe(false);
    expect(imap.uidsIn("Sent")).toEqual([]);
  });

  it("does not append for Microsoft 365", async () => {
    const m = await message();
    const result = await deliver({ ...deps, imapHost: "outlook.office365.com" }, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });
    expect(result.sentCopy.saved).toBe(false);
  });

  it("remembers when an unknown server files the copy itself", async () => {
    const m = await message();
    imap.addMessage("Sent", m.raw); // the server already filed it
    const first = await deliver(deps, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });
    expect(first.sentCopy.saved).toBe(false);
    expect(deps.sentProbeCache.get("mail.example.com")).toBe(true);
    expect(imap.uidsIn("Sent")).toHaveLength(1);
  });

  it("reports a failed Sent copy without failing the send", async () => {
    imap.failOn("append", "throw");
    const m = await message();
    const result = await deliver({ ...deps, sentCopy: "always" }, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });
    expect(capture.sent).toHaveLength(1);
    expect(result.sentCopy.saved).toBe(false);
    expect(result.sentCopy.reason).toMatch(/WAS sent/);
  });

  it("propagates SMTP failures and stores nothing", async () => {
    capture.failNext(new Error("550 relay denied"));
    const m = await message();
    await expect(deliver(deps, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId })).rejects.toThrow(/relay denied/);
    expect(imap.uidsIn("Sent")).toEqual([]);
  });
});
