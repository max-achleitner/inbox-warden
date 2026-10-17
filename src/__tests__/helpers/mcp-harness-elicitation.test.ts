import { describe, it, expect } from "vitest";
import { z } from "zod";
import { acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import { connectHarness } from "./mcp-harness.js";

describe("connectHarness elicitation support", () => {
  it("answers elicitations and exposes tool metadata", async () => {
    const schema = z.object({ confirm: z.boolean() });
    const h = await connectHarness(
      (server) =>
        server.registerTool(
          "ask",
          { title: "Ask", description: "asks", inputSchema: z.object({}), _meta: { "anthropic/requiresUserInteraction": true } },
          async (_args, ctx) => {
            const answer = acceptedContent(ctx.mcpReq.inputResponses, "c", schema);
            if (!answer) return inputRequired({ inputRequests: { c: inputRequired.elicit({ message: "Sure?", requestedSchema: schema }) } });
            return { content: [{ type: "text", text: JSON.stringify(answer) }] };
          },
        ),
      { elicitation: () => ({ action: "accept", content: { confirm: true } }) },
    );
    const res = await h.call("ask");
    expect(res.json).toEqual({ confirm: true });
    expect(h.elicitations).toEqual(["Sure?"]);
    expect(await h.toolMeta("ask")).toMatchObject({ "anthropic/requiresUserInteraction": true });
    expect(await h.description("ask")).toBe("asks");
    await h.close();
  });
});
