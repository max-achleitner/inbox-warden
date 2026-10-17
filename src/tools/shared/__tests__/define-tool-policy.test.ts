import { describe, it, expect } from "vitest";
import { createTestApp } from "../../../__tests__/helpers/test-app.js";
import type { ToolCallEvent } from "../../../context.js";
import { PolicyDeniedError, PolicyEngine } from "../../../policy/engine.js";
import { defineTool } from "../define-tool.js";
import * as sendEmail from "../../send-email.js";
import * as createDraft from "../../create-draft.js";

describe("defineTool with policy", () => {
  it("attaches a PolicyEngine to every account", () => {
    const t = createTestApp([{ id: "main" }, { id: "office", email: "office@firma.example" }]);
    for (const account of t.app.accounts.values()) expect(account.policy).toBeInstanceOf(PolicyEngine);
  });

  it("reports a PolicyDeniedError as outcome denied", async () => {
    const t = createTestApp();
    const events: ToolCallEvent[] = [];
    t.app.observers.push({ onToolCall: (event) => { events.push(event); } });
    const h = await t.connect((server, app) =>
      defineTool(
        server,
        app,
        {
          name: "probe",
          title: "Probe",
          description: "Test probe",
          tier: "read",
          input: {},
          annotations: { readOnlyHint: true, destructiveHint: false },
          errorPrefix: "Probe failed",
        },
        async () => {
          throw new PolicyDeniedError("Blocked by policy.", "test");
        },
      ),
    );
    const res = await h.call("probe");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Blocked by policy.");
    expect(events.at(-1)).toMatchObject({ tool: "probe", outcome: "denied" });
    await h.close();
  });

  it("does not offer send tools when every account is drafts-only", async () => {
    const t = createTestApp([{ policy: { send: { mode: "drafts-only" } } }]);
    const h = await t.connect(sendEmail.register, createDraft.register);
    const tools = await h.listTools();
    expect(tools).not.toContain("send_email");
    expect(tools).toContain("create_draft");
    await h.close();
  });

  it("refuses send calls for a drafts-only account next to a sending account", async () => {
    const t = createTestApp([
      { id: "main" },
      { id: "office", email: "office@firma.example", policy: { send: { mode: "drafts-only" } } },
    ]);
    const h = await t.connect(sendEmail.register);
    const res = await h.call("send_email", { account: "office", to: "kunde@example.com", subject: "Hallo", body: "Text" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/drafts-only/);
    expect(t.capture("office").sent).toHaveLength(0);
    await h.close();
  });
});
