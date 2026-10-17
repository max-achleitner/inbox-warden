import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { clientCapabilitiesOf, requireConfirmation } from "../confirm.js";
import { operationDigest } from "../confirm-state.js";

type Reply = { action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> };

async function setup(opts: { elicit?: (message: string) => Reply; required?: boolean; mutate?: boolean }) {
  const server = new McpServer({ name: "s", version: "1" });
  let round = 0;
  server.registerTool(
    "act",
    { title: "Act", description: "test", inputSchema: z.object({ to: z.string() }) },
    async ({ to }, ctx) => {
      round++;
      const digest = operationDigest({ to, version: opts.mutate && round > 1 ? "changed" : "original" });
      const outcome = requireConfirmation(
        { sdk: ctx, clientCapabilities: () => clientCapabilitiesOf(server, ctx) },
        { message: `Send to ${to}?`, digest, required: opts.required ?? false },
      );
      if (outcome.status === "pending") return outcome.result;
      if (outcome.status === "refused") return { content: [{ type: "text", text: outcome.reason }], isError: true };
      return { content: [{ type: "text", text: outcome.status }] };
    },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "c", version: "1" },
    opts.elicit ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const asked: string[] = [];
  if (opts.elicit) {
    const elicit = opts.elicit;
    client.setRequestHandler("elicitation/create", async (request) => {
      const message = (request.params as { message: string }).message;
      asked.push(message);
      return elicit(message);
    });
  }
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async () => {
    const res = await client.callTool({ name: "act", arguments: { to: "kunde@example.com" } });
    return { isError: res.isError === true, text: (res.content as Array<{ text: string }>)[0].text };
  };
  return { call, asked };
}

// In-memory connections negotiate the 2025 era, so these rounds run through the SDK legacy shim
// (server→client elicitation, then the handler is re-entered with inputResponses + requestState).
// 2026-07-28 clients deliver the same inputResponses/requestState to the same handler.
describe("requireConfirmation over SDK v2", () => {
  it("asks the user and proceeds on accept", async () => {
    const t = await setup({ elicit: () => ({ action: "accept", content: { confirm: true } }) });
    expect(await t.call()).toEqual({ isError: false, text: "confirmed" });
    expect(t.asked).toEqual(["Send to kunde@example.com?"]);
  });

  it("refuses on decline", async () => {
    const t = await setup({ elicit: () => ({ action: "decline" }) });
    const res = await t.call();
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/declined or cancelled/);
  });

  it("refuses when the user unticks the box", async () => {
    const t = await setup({ elicit: () => ({ action: "accept", content: { confirm: false } }) });
    expect((await t.call()).text).toMatch(/did not confirm/);
  });

  it("refuses when the operation changed between the dialog and the retry", async () => {
    const t = await setup({ elicit: () => ({ action: "accept", content: { confirm: true } }), mutate: true });
    expect((await t.call()).text).toMatch(/does not match this exact action/);
  });

  it("falls back to client approval when the client cannot elicit", async () => {
    const t = await setup({});
    expect(await t.call()).toEqual({ isError: false, text: "client-approval" });
  });

  it("refuses when confirmation is required and the client cannot elicit", async () => {
    const t = await setup({ required: true });
    expect((await t.call()).text).toMatch(/cannot show a confirmation dialog/);
  });
});
