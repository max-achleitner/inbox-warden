import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as signIn from "../sign-in.js";

describe("sign_in tool", () => {
  it("is available for every account and annotated as open-world, not destructive", async () => {
    const h = await createTestApp().connect(signIn.register);
    try {
      expect(await h.listTools()).toContain("sign_in");
      expect(await h.annotations("sign_in")).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    } finally {
      await h.close();
    }
  });

  it("tells Claude that password mailboxes need no sign-in", async () => {
    const h = await createTestApp().connect(signIn.register);
    try {
      const res = await h.call("sign_in", {});
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ status: "not_needed" });
    } finally {
      await h.close();
    }
  });
});
