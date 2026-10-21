import { describe, it, expect } from "vitest";
import { PolicySchema } from "../schema.js";
import { AuditSchema } from "../../audit/schema.js";

describe("PolicySchema", () => {
  it("fills safe defaults from an empty object", () => {
    expect(PolicySchema.parse({})).toEqual({
      send: {
        mode: "confirm",
        blockedRecipientDomains: [],
        maxRecipients: 20,
        maxPerHour: 20,
        maxPerDay: 100,
        flagNewRecipients: true,
        confirmAfterInjectionRisk: "high",
        requireElicitation: false,
      },
      bulk: { maxMessages: 500, maxDelete: 100 },
      folders: { deny: [] },
      protectedFolders: true,
      attachments: { maxDownloadBytes: 26214400, blockExecutables: true },
    });
  });

  it("defaults confirmAfterInjectionRisk to high", () => {
    expect(PolicySchema.parse({}).send.confirmAfterInjectionRisk).toBe("high");
  });

  it("normalises recipient domains", () => {
    const policy = PolicySchema.parse({ send: { blockedRecipientDomains: ["GMAIL.com", "*.Müller.de"] } });
    expect(policy.send.blockedRecipientDomains).toEqual(["gmail.com", "*.xn--mller-kva.de"]);
  });

  it("rejects invalid domains and misspelt settings", () => {
    expect(() => PolicySchema.parse({ send: { allowedRecipientDomains: ["not a domain"] } })).toThrow(/example\.com/);
    expect(() => PolicySchema.parse({ send: { maxPerHours: 5 } })).toThrow();
    expect(() => PolicySchema.parse({ protectedFolder: false })).toThrow();
  });

  it("rejects an empty folder allow list instead of reading it as no restriction", () => {
    expect(() => PolicySchema.parse({ folders: { allow: [] } })).toThrow(/folders\.allow/);
  });

  it("parses an empty policy through prefault on the account schema", () => {
    expect(PolicySchema.prefault({}).parse(undefined).send.mode).toBe("confirm");
  });
});

describe("AuditSchema", () => {
  it("defaults to enabled, standard level, one year", () => {
    expect(AuditSchema.parse({})).toEqual({ enabled: true, level: "standard", retentionDays: 365, includeReads: false });
  });
});
