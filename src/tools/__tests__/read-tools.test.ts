import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as readEmail from "../read-email.js";
import * as downloadAttachment from "../download-attachment.js";

describe("read tools", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    const t = createTestApp();
    imap = t.imap();
    imap.addMessage("INBOX", await buildRaw({ from: "a@example.com", to: "me@example.com", subject: "Hallo", text: "Inhalt" }));
    h = await t.connect(readEmail.register, downloadAttachment.register);
  });

  afterEach(async () => {
    await h.close();
  });

  it("read_email resolves the folder name case-insensitively", async () => {
    const res = await h.call("read_email", { folder: "inbox", uid: 1 });
    expect(res.isError).toBe(false);
    expect(res.json.subject).toBe("Hallo");
  });

  it("read_email explains a missing UID instead of a parser error", async () => {
    const res = await h.call("read_email", { uid: 42 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No message with UID 42 exists in "INBOX"/);
  });

  it("download_attachment reports an unknown folder", async () => {
    const res = await h.call("download_attachment", { folder: "Rechnungen", uid: 1, attachmentIndex: 0 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Folder "Rechnungen" does not exist/);
  });
});
