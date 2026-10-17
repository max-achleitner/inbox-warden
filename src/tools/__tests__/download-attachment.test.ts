import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as downloadAttachment from "../download-attachment.js";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

async function setup(files: Record<string, unknown> = {}) {
  const t = createTestApp(undefined, { files: { maxInlineTextBytes: 2048, maxInlineImageBytes: 2048, ...files } });
  t.imap().addMessage(
    "INBOX",
    await buildRaw({
      from: "k@example.com",
      to: "max@firma.example",
      subject: "Dateien",
      text: "Anbei",
      attachments: [
        { filename: "notiz.txt", content: "Hallo Welt" },
        { filename: "bild.png", content: PNG_1PX, contentType: "image/png" },
        { filename: "Rechnung.pdf", content: Buffer.from("%PDF-1.7"), contentType: "application/pdf" },
        { filename: "log.txt", content: "x".repeat(5000) },
        { filename: "foto.jpg", content: Buffer.alloc(5000, 1), contentType: "image/jpeg" },
      ],
    }),
  );
  return { t, h: await t.connect(downloadAttachment.register) };
}

describe("download_attachment", () => {
  it("is read-only", async () => {
    const { h } = await setup();
    expect(await h.annotations("download_attachment")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    await h.close();
  });

  it("returns small text inline", async () => {
    const { h } = await setup();
    const res = await h.call("download_attachment", { uid: 1, attachmentIndex: 0 });
    expect(res.json).toMatchObject({ filename: "notiz.txt", encoding: "utf-8", content: "Hallo Welt" });
    await h.close();
  });

  it("returns small images as MCP image content", async () => {
    const { h } = await setup();
    const res = await h.call("download_attachment", { uid: 1, attachmentIndex: 1 });
    expect(res.json).toMatchObject({ filename: "bild.png", encoding: "image" });
    expect(res.content[1]).toEqual({ type: "image", data: PNG_1PX.toString("base64"), mimeType: "image/png" });
    await h.close();
  });

  it("never returns other binary types as base64 and points to save_attachment", async () => {
    const { h } = await setup({ downloadDir: "/data/downloads" });
    const res = await h.call("download_attachment", { uid: 1, attachmentIndex: 2 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not a text or image file/);
    expect(res.text).toMatch(/save_attachment/);
    expect(res.text).not.toMatch(/JVBERi/); // base64 of "%PDF"
    await h.close();
  });

  it("refuses text and images above their limits", async () => {
    const { h } = await setup();
    const text = await h.call("download_attachment", { uid: 1, attachmentIndex: 3 });
    expect(text.isError).toBe(true);
    expect(text.text).toMatch(/more than the 2 KB of text/);
    const image = await h.call("download_attachment", { uid: 1, attachmentIndex: 4 });
    expect(image.isError).toBe(true);
    expect(image.text).toMatch(/files\.downloadDir/); // saving not configured in this setup
    await h.close();
  });

  it("reports a missing attachment index", async () => {
    const { h } = await setup();
    const res = await h.call("download_attachment", { uid: 1, attachmentIndex: 9 });
    expect(res.text).toMatch(/No attachment at index 9\. Email has 5 attachments/);
    await h.close();
  });
});
