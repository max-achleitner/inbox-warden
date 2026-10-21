import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { mailFixture } from "../../__tests__/helpers/mail-fixtures.js";
import * as readEmail from "../read-email.js";

describe("real newsletters and replies through read_email", () => {
  it.each(["woopayments-newsletter", "world4you-renewal", "gmail-reply"] as const)("%s scans none and sets no risk", async (name) => {
    const { html, text } = mailFixture(name);
    const t = createTestApp();
    t.imap().addMessage("INBOX", await buildRaw({ from: "news@example.com", to: "max@firma.example", subject: "Info", text, html }));
    const h = await t.connect(readEmail.register);
    const res = await h.call("read_email", { uid: 1 });
    expect(res.json._injectionScan.riskLevel).toBe("none");
    expect(res.json._injectionScan.hasInjection).toBe(false);
    expect(t.app.accounts.get("main")!.policy.activeInjectionRisk()).toBeNull();
    await h.close();
  });
});
