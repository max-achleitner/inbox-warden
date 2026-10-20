import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PolicyDeniedError, PolicyEngine, isExecutableFilename, tierAllowed, tierDenialMessage } from "../engine.js";
import { PolicySchema, type Policy } from "../schema.js";
import { AccountSchema } from "../../config/schema.js";

function policy(send: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): Policy {
  return PolicySchema.parse({ send, ...rest });
}

function engine(p: Policy, now: () => number = Date.now) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-state-"));
  return new PolicyEngine("main", p, ["max@firma.example"], { stateDir, now });
}

describe("PolicyEngine", () => {
  it("drafts-only removes the send tier", () => {
    const account = AccountSchema.parse({
      id: "main",
      email: "max@firma.example",
      imap: { host: "mail.firma.example", port: 993 },
      permissions: { send: true },
      policy: { send: { mode: "drafts-only" } },
    });
    expect(tierAllowed(account, "send")).toBe(false);
    expect(tierAllowed(account, "write")).toBe(true);
    expect(tierDenialMessage(account, "send")).toMatch(/drafts-only/);
    expect(tierDenialMessage(account, "delete")).toMatch(/does not allow delete actions. Nothing was changed/);
  });

  it("enforces the hourly send limit", () => {
    const e = engine(policy({ maxPerHour: 1 }));
    e.checkRate();
    e.reserveSend();
    expect(() => e.checkRate()).toThrow(PolicyDeniedError);
    expect(() => e.reserveSend()).toThrow(/per hour.*Nothing was sent/);
  });

  it("gives a reserved send slot back when delivery fails", () => {
    const e = engine(policy({ maxPerHour: 1 }));
    e.reserveSend().release();
    expect(() => e.reserveSend()).not.toThrow();
  });

  it("caps bulk operations with a stricter limit for deletes", () => {
    const e = engine(policy({}, { bulk: { maxMessages: 10, maxDelete: 2 } }));
    e.checkBulk(10, "move");
    expect(() => e.checkBulk(11, "move")).toThrow(/11 messages match, more than the limit of 10 per operation set in this mailbox's settings\. Nothing was changed\. Do not split/);
    expect(() => e.checkBulk(3, "delete")).toThrow(/limit of 2 per operation for deleting/);
  });

  it("names the locked folder in the refusal, with the full message", () => {
    const e = engine(policy({}, { folders: { deny: ["Privat/**"] } }));
    expect(() => e.checkFolder("Privat")).toThrow(/^The folder "Privat" is locked in this mailbox's settings\. Nothing was changed\.$/);
  });

  it("does not suggest splitting a capped bulk change into smaller ones", () => {
    const e = engine(policy({}, { bulk: { maxMessages: 10, maxDelete: 2 } }));
    let message = "";
    try {
      e.checkBulk(11, "move");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toMatch(/since\/before/);
    expect(message).toMatch(/do not split/i);
    expect(message).toMatch(/inbox-warden accounts edit/);
  });

  it("protects INBOX and special-use folders", () => {
    const e = engine(policy());
    expect(() => e.checkProtectedFolder("inbox", false)).toThrow(/protected/);
    expect(() => e.checkProtectedFolder("Gesendet", true)).toThrow(/protected/);
    e.checkProtectedFolder("Projekte", false);
  });

  it("blocks executables only when saving to disk", () => {
    const e = engine(policy());
    expect(isExecutableFilename("Rechnung.PDF.exe")).toBe(true);
    expect(isExecutableFilename("invoice.exe.")).toBe(true); // Windows drops trailing dots and spaces
    expect(isExecutableFilename("invoice.exe ")).toBe(true);
    e.checkAttachment("tool.exe", 10, false);
    expect(() => e.checkAttachment("tool.exe", 10, true)).toThrow(/program or script/);
    expect(() => e.checkAttachment("big.pdf", 30 * 1024 * 1024, false)).toThrow(/MB/);
  });

  it.each([
    "setup.exe", "Rechnung.pdf.exe", "makro.XLSM", "script.ps1", "disk.iso", "invoice.exe.", "invoice.exe ", "invoice.exe. .",
    "vorlage.dotm", "link.url", "app.apk", "hook.dll", "notiz.one",
    "folien.ppsm", "daten.xlsb", "handbuch.chm", "addin.xll", "konsole.msc", "app.appxbundle", "app.msixbundle", "update.appinstaller",
  ])("treats %s as executable (one list for every check)", (name) => {
    expect(isExecutableFilename(name)).toBe(true);
  });

  it.each(["Rechnung.pdf", "Foto.jpg", "Tabelle.xlsx", "README"])("does not treat %s as executable", (name) => {
    expect(isExecutableFilename(name)).toBe(false);
  });

  it("lets an administrator allow saving executables with blockExecutables: false", () => {
    engine(policy({}, { attachments: { blockExecutables: false } })).checkAttachment("tool.exe", 10, true);
  });

  it("escalates after an injection finding at or above the threshold and decays after an hour", () => {
    let now = 0;
    const e = engine(policy({ confirmAfterInjectionRisk: "high" }), () => now);
    e.noteInjectionRisk("medium");
    expect(e.injectionEscalation()).toBeNull();
    e.noteInjectionRisk("critical");
    expect(e.injectionEscalation()).toBe("critical");
    e.noteInjectionRisk("low"); // a lower finding never downgrades
    expect(e.injectionEscalation()).toBe("critical");
    now += 61 * 60 * 1000;
    expect(e.injectionEscalation()).toBeNull();
  });

  it("allows own domains even with an allow list", () => {
    const e = engine(policy({ allowedRecipientDomains: ["kunde.at"] }));
    expect(e.checkRecipients(["Kollege@Firma.example", "a@kunde.at"])).toEqual(["kollege@firma.example", "a@kunde.at"]);
    expect(() => e.checkRecipients(["x@gmail.com"])).toThrow(PolicyDeniedError);
  });
});
