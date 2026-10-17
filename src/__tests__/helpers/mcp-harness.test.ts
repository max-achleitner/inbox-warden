import { describe, it, expect } from "vitest";
import { connectHarness } from "./mcp-harness.js";

describe("connectHarness", () => {
  it("exposes the raw content blocks next to the parsed JSON", async () => {
    const h = await connectHarness((server) => {
      server.registerTool("pic", { description: "returns an image" }, async () => ({
        content: [
          { type: "text", text: '{"ok":true}' },
          { type: "image", data: "AA==", mimeType: "image/png" },
        ],
      }));
    });
    const res = await h.call("pic");
    expect(res.json).toEqual({ ok: true });
    expect(res.content[1]).toEqual({ type: "image", data: "AA==", mimeType: "image/png" });
    await h.close();
  });
});
