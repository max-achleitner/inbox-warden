import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { simpleParser } from "mailparser";
import type { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { header } from "../../__tests__/helpers/messages.js";
import * as createDraft from "../create-draft.js";


describe("create_draft", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    const t = createTestApp();
    imap = t.imap();
    h = await t.connect(createDraft.register);
  });

  afterEach(async () => {
    await h.close();
  });

  it("stores an RFC-compliant draft and returns its uid", async () => {
    const res = await h.call("create_draft", {
      to: "kunde@example.com",
      subject: "Angebot",
      body: "Anbei das Angebot.",
      attachments: [{ filename: "Angebot_Größe.pdf", content: Buffer.from("%PDF").toString("base64"), contentType: "application/pdf" }],
    });
    expect(res.isError).toBe(false);
    expect(res.json.uid).toBe(1);
    const draft = imap.message("Drafts", 1)!;
    expect(draft.flags.has("\\Draft")).toBe(true);
    expect(header(draft.raw, "message-id")).toMatch(/@firma.example>$/);
    const parsed = await simpleParser(draft.raw);
    expect(parsed.attachments[0].filename).toBe("Angebot_Größe.pdf");
  });

  it("finds a German-named Drafts folder without SPECIAL-USE", async () => {
    imap.folders.delete("Drafts");
    imap.addFolder("Entwürfe");
    const res = await h.call("create_draft", { to: "a@example.com", subject: "s", body: "b" });
    expect(res.isError).toBe(false);
    expect(res.json.folder).toBe("Entwürfe");
  });

  it("reports a refused APPEND as an error", async () => {
    imap.failOn("append", "false");
    const res = await h.call("create_draft", { to: "a@example.com", subject: "s", body: "b" });
    expect(res.isError).toBe(true);
  });

  it("mentions send_draft only when some account offers the send tier", async () => {
    const off = createTestApp([{ permissions: { read: true, write: true, send: false, delete: false } }]);
    const hOff = await off.connect(createDraft.register);
    expect(await hOff.description("create_draft")).not.toContain("send_draft");
    await hOff.close();

    const on = createTestApp();
    const hOn = await on.connect(createDraft.register);
    expect(await hOn.description("create_draft")).toContain("send_draft");
    await hOn.close();
  });
});
