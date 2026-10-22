import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { PolicyDeniedError, PolicyEngine } from "../engine.js";
import { InjectionRiskObserver, highestRisk } from "../observer.js";
import { findNewRecipients, guardOutbound } from "../outbound.js";
import { UNSCOPED } from "../../imap/strict.js";
import { gmailFakeImap } from "../../__tests__/helpers/test-app.js";
import { LabelLock } from "../label-lock.js";
import { PolicySchema } from "../schema.js";

/** `capabilities` defaults to a connected client that declared no elicitation. */
function setup(policyInput: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}) {
  const imap = new FakeImap();
  imap.addFolder("Sent", { specialUse: "\\Sent" });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-state-"));
  const policy = new PolicyEngine("main", PolicySchema.parse(policyInput), ["max@firma.example"], { stateDir });
  const recorded: Record<string, unknown> = {};
  const inv = {
    sdk: { mcpReq: { inputResponses: undefined, requestState: () => undefined } } as never,
    record: (d: Record<string, unknown>) => Object.assign(recorded, d),
    clientCapabilities: () => capabilities as never,
    account: { policy, getClient: async () => imap.asClient() },
  };
  return { imap, policy, inv, recorded };
}

const request = { action: "send_email" as const, from: "max@firma.example", recipients: ["kunde@example.com"], subject: "Angebot", attachmentCount: 0, digest: "d" };

describe("guardOutbound", () => {
  it("proceeds without a question in direct mode", async () => {
    const t = setup({ send: { mode: "direct" } });
    expect(await guardOutbound(t.inv, request)).toMatchObject({ proceed: true, confirmation: "not-required" });
    expect(t.recorded).toMatchObject({ recipients: ["kunde@example.com"], newRecipients: ["kunde@example.com"] });
  });

  it("returns an input_required result in confirm mode when the client can elicit", async () => {
    const t = setup({}, { elicitation: { form: {} } });
    const decision = await guardOutbound(t.inv, request);
    expect(decision.proceed).toBe(false);
    if (!decision.proceed) expect(JSON.stringify(decision.result)).toContain("Never emailed before: kunde@example.com");
  });

  it("falls back to client approval in confirm mode without elicitation", async () => {
    const t = setup();
    expect(await guardOutbound(t.inv, request)).toMatchObject({ proceed: true, confirmation: "client-approval" });
  });

  it("refuses in confirm mode when the client's capabilities are unknown (stateless HTTP, 2025 era)", async () => {
    const t = setup();
    t.inv.clientCapabilities = () => undefined as never;
    await expect(guardOutbound(t.inv, request)).rejects.toThrow(/cannot tell whether your app can show a confirmation dialog/);
  });

  it("refuses in direct mode after an injection finding when the client cannot elicit", async () => {
    const t = setup({ send: { mode: "direct" } });
    new InjectionRiskObserver([t].map((x) => ({ policy: x.policy }))).onToolCall({
      tool: "read_email", accountId: "main", tier: "read", outcome: "success", durationMs: 1, details: { injectionRisk: "high" },
    });
    await expect(guardOutbound(t.inv, request)).rejects.toThrow(/cannot show a confirmation dialog/);
  });

  it("in confirm mode an injection finding only adds a warning line", async () => {
    const elicits = setup({}, { elicitation: { form: {} } });
    const observe = (t: ReturnType<typeof setup>) =>
      new InjectionRiskObserver([t].map((x) => ({ policy: x.policy }))).onToolCall({
        tool: "read_email", accountId: "main", tier: "read", outcome: "success", durationMs: 1, details: { injectionRisk: "high" },
      });
    observe(elicits);
    const pending = await guardOutbound(elicits.inv, request);
    expect(pending.proceed).toBe(false);
    if (!pending.proceed) {
      expect(JSON.stringify(pending.result)).toContain("Warning: an email read in this session looked like a manipulation attempt (risk: high)");
    }
    const plain = setup();
    observe(plain);
    expect(await guardOutbound(plain.inv, request)).toMatchObject({ proceed: true, confirmation: "client-approval" });
    expect(plain.recorded.injectionEscalation).toBe("high");
  });

  describe("refusal rules and escalation outcomes", () => {
    const observe = (t: ReturnType<typeof setup>, injectionRisk: "high" | "critical") =>
      new InjectionRiskObserver([t].map((x) => ({ policy: x.policy }))).onToolCall({
        tool: "read_email", accountId: "main", tier: "read", outcome: "success", durationMs: 1, details: { injectionRisk },
      });
    const rejection = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (err) {
        return err;
      }
      throw new Error("expected a refusal");
    };

    it("direct mode with a high finding and no dialog is refused with send.injectionEscalation", async () => {
      const t = setup({ send: { mode: "direct" } });
      observe(t, "high");
      const err = await rejection(guardOutbound(t.inv, request));
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect((err as PolicyDeniedError).rule).toBe("send.injectionEscalation");
    });

    it("confirm mode with requireElicitation and no dialog is refused with send.confirmation", async () => {
      const t = setup({ send: { requireElicitation: true } });
      const err = await rejection(guardOutbound(t.inv, request));
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect((err as PolicyDeniedError).rule).toBe("send.confirmation");
    });

    it("confirm mode with a finding and unknown client capabilities is refused", async () => {
      const t = setup();
      t.inv.clientCapabilities = () => undefined as never;
      observe(t, "high");
      const err = await rejection(guardOutbound(t.inv, request));
      expect(err).toBeInstanceOf(PolicyDeniedError);
      expect((err as PolicyDeniedError).rule).toBe("send.confirmation");
    });

    it("a critical finding in confirm mode with a dialog is pending and carries the warning line", async () => {
      const t = setup({}, { elicitation: { form: {} } });
      observe(t, "critical");
      const decision = await guardOutbound(t.inv, request);
      expect(decision.proceed).toBe(false);
      if (!decision.proceed) {
        expect(JSON.stringify(decision.result)).toContain("looked like a manipulation attempt (risk: critical)");
      }
    });
  });

  it("a medium finding does not escalate with the default threshold", async () => {
    const t = setup({ send: { mode: "direct" } });
    new InjectionRiskObserver([t].map((x) => ({ policy: x.policy }))).onToolCall({
      tool: "read_email", accountId: "main", tier: "read", outcome: "success", durationMs: 1, details: { injectionRisk: "medium" },
    });
    expect(await guardOutbound(t.inv, request)).toMatchObject({ proceed: true, confirmation: "not-required" });
  });

  it("enforces recipient rules before anything else", async () => {
    const t = setup({ send: { blockedRecipientDomains: ["example.com"] } });
    await expect(guardOutbound(t.inv, request)).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it("knows recipients from the Sent folder", async () => {
    const t = setup();
    t.imap.addMessage("Sent", await buildRaw({ from: "max@firma.example", to: "Kunde@Example.com", subject: "x", text: "y" }));
    expect(await findNewRecipients(t.imap.asClient(), ["kunde@example.com", "neu@example.com"], UNSCOPED)).toEqual(["neu@example.com"]);
  });

  it("flags a lookalike that only appears inside a known address (IMAP search matches substrings)", async () => {
    const t = setup();
    t.imap.addMessage("Sent", await buildRaw({ from: "max@firma.example", to: "john@acme.com", subject: "x", text: "y" }));
    expect(await findNewRecipients(t.imap.asClient(), ["john@acme.co", "ohn@acme.com", "john@acme.com"], UNSCOPED)).toEqual([
      "john@acme.co",
      "ohn@acme.com",
    ]);
  });

  it("knows recipients that were only in Bcc", async () => {
    const t = setup();
    t.imap.addMessage("Sent", await buildRaw({ from: "max@firma.example", to: "a@example.com", bcc: "geheim@example.com", subject: "x", text: "y" }));
    expect(await findNewRecipients(t.imap.asClient(), ["geheim@example.com"], UNSCOPED)).toEqual([]);
  });

  it("does not count Sent mail that carries a hidden Gmail label: its recipients stay new", async () => {
    const imap = gmailFakeImap(["_NDA_Inbox"]);
    imap.addGmailMessage(await buildRaw({ from: "max@firma.example", to: "partner@partner.example", subject: "x", text: "y" }), ["\\Sent", "_NDA_Inbox"]);
    imap.addGmailMessage(await buildRaw({ from: "max@firma.example", to: "kunde@example.com", subject: "x", text: "y" }), ["\\Sent"]);
    const scope = new LabelLock({ deny: ["_NDA_Inbox"] });
    expect(await findNewRecipients(imap.asClient(), ["partner@partner.example", "kunde@example.com"], scope)).toEqual(["partner@partner.example"]);
    expect(await findNewRecipients(imap.asClient(), ["partner@partner.example"], UNSCOPED)).toEqual([]);
  });

  it("highestRisk picks the maximum", () => {
    expect(highestRisk(["low", undefined, "high", "medium"])).toBe("high");
    expect(highestRisk([])).toBe("none");
  });
});
