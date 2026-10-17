import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createTestApp } from "../../../__tests__/helpers/test-app.js";
import type { ToolCallEvent } from "../../../context.js";
import { defineTool } from "../define-tool.js";
import { jsonResult } from "../result.js";

/** A probe tool that reports which account it ran against. */
function probe(tier: "read" | "write" | "send" | "delete" | "always", fail = false) {
  return (server: Parameters<typeof defineTool>[0], app: Parameters<typeof defineTool>[1]) =>
    defineTool(
      server,
      app,
      {
        name: "probe",
        title: "Probe",
        description: "test tool",
        tier,
        input: { value: z.string().default("x") },
        annotations: { readOnlyHint: true, destructiveHint: false },
        errorPrefix: "Error probing",
      },
      async ({ value }, inv) => {
        inv.record({ value });
        if (fail) throw new Error("boom");
        return jsonResult({ account: inv.account.id, email: inv.account.config.email, value });
      },
    );
}

describe("defineTool", () => {
  it("routes calls to the requested account and defaults to the first one", async () => {
    const t = createTestApp([{ id: "office", email: "office@firma.at" }, { id: "private", email: "max@gmx.at" }]);
    const h = await t.connect(probe("read"));
    expect((await h.call("probe", {})).json).toMatchObject({ account: "office" });
    expect((await h.call("probe", { account: "private" })).json).toMatchObject({ account: "private", email: "max@gmx.at" });
    await h.close();
  });

  it("lists the available accounts when an unknown one is requested", async () => {
    const t = createTestApp([{ id: "office" }, { id: "private" }]);
    const h = await t.connect(probe("read"));
    const res = await h.call("probe", { account: "shop" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no mail account "shop".*"office", "private"/);
    await h.close();
  });

  it("does not register a tool when no account grants its tier", async () => {
    const t = createTestApp([{ permissions: { send: false } }]);
    const h = await t.connect(probe("send"));
    expect(await h.listTools()).toEqual([]);
    await h.close();
  });

  it("denies the call for an account without the tier even if another account has it", async () => {
    const t = createTestApp([{ id: "office", permissions: { send: true } }, { id: "private", permissions: { send: false } }]);
    const h = await t.connect(probe("send"));
    const res = await h.call("probe", { account: "private" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not allow send actions. Nothing was changed/);
    await h.close();
  });

  it("adds the title to the annotations", async () => {
    const t = createTestApp();
    const h = await t.connect(probe("read"));
    expect(await h.annotations("probe")).toMatchObject({ title: "Probe", readOnlyHint: true });
    await h.close();
  });

  it("maps exceptions to errors and notifies observers with recorded details", async () => {
    const t = createTestApp();
    const events: ToolCallEvent[] = [];
    t.app.observers.push({ onToolCall: (e) => { events.push(e); } });
    t.app.observers.push({ onToolCall: () => { throw new Error("observer bug"); } });
    const h = await t.connect(probe("read", true));
    const res = await h.call("probe", { value: "v1" });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("Error probing: boom");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "probe", accountId: "main", tier: "read", outcome: "error", details: { value: "v1" }, error: "Error probing: boom" });
    await h.close();
  });
});
