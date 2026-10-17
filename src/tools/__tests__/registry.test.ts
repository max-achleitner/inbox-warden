import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { ALL_TOOLS } from "../index.js";

describe("tool registry", () => {
  it("registers the Plan 3 tools", async () => {
    const t = createTestApp();
    const h = await t.connect(...ALL_TOOLS);
    const names = await h.listTools();
    expect(names).toContain("save_attachment");
    expect(names).toContain("organize_by_filter");
    expect(names).toContain("get_thread");
    expect(names).toContain("forward_draft");
    await h.close();
  });
});
