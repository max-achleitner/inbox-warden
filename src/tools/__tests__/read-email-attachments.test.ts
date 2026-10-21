import { describe, it, expect, afterEach } from "vitest";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as readEmail from "../read-email.js";
import * as searchEmails from "../search-emails.js";

const PNG = Buffer.from("iVBORw0KGgo=", "base64");
const logo = { filename: "logo.png", content: PNG, contentType: "image/png", cid: "logo@example.com" };
const html = '<p>Hi</p><img src="cid:logo@example.com">';

describe("read_email attachments", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  async function open(attachments: any[]) {
    const t = createTestApp();
    t.imap().addMessage(
      "INBOX",
      await buildRaw({ from: "a@example.com", to: "me@example.com", subject: "Mit Logo", text: "Hi", html, attachments }),
    );
    h = await t.connect(readEmail.register, searchEmails.register);
  }

  it("marks only the embedded image and still lists every part by index", async () => {
    await open([{ filename: "rechnung.pdf", content: "pdf", contentType: "application/pdf" }, logo]);
    const res = await h.call("read_email", { uid: 1 });
    expect(res.json.hasAttachment).toBe(true);
    // mailparser lists the related (embedded) parts first; the index is what the download tools use
    expect(res.json.attachments.map((a: any) => [a.index, a.filename, a.embedded])).toEqual([
      [0, "logo.png", true],
      [1, "rechnung.pdf", undefined],
    ]);
  });

  it("reports no attachment for a mail with only an embedded image, like search_emails", async () => {
    await open([logo]);
    const res = await h.call("read_email", { uid: 1 });
    expect(res.json.hasAttachment).toBe(false);
    expect(res.json.attachments).toHaveLength(1);
    expect(res.json.attachments[0].embedded).toBe(true);
    const search = await h.call("search_emails", {});
    expect(search.json.messages[0].hasAttachment).toBe(false);
  });
});
