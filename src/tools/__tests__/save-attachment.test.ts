import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as saveAttachment from "../save-attachment.js";

describe("save_attachment", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "imap-mcp-save-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(files: Record<string, unknown> = { downloadDir: path.join(dir, "downloads") }) {
    const t = createTestApp(undefined, { files });
    t.imap().addMessage(
      "INBOX",
      await buildRaw({
        from: "k@example.com",
        to: "max@firma.example",
        subject: "Dateien",
        text: "Anbei",
        attachments: [
          { filename: "Rechnung.pdf", content: Buffer.alloc(10_000, 1), contentType: "application/pdf" },
          { filename: "../../Rechnung.pdf.exe", content: Buffer.from("MZ"), contentType: "application/octet-stream" },
          { filename: "invoice.exe.", content: Buffer.from("MZ"), contentType: "application/octet-stream" },
        ],
      }),
    );
    return { t, h: await t.connect(saveAttachment.register) };
  }

  it("is a write-tier, non-destructive tool", async () => {
    const { h } = await setup();
    expect(await h.annotations("save_attachment")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    await h.close();
  });

  it("is not registered when no account grants the write tier", async () => {
    const t = createTestApp([{ permissions: { write: false } }], { files: { downloadDir: dir } });
    const h = await t.connect(saveAttachment.register);
    expect(await h.listTools()).not.toContain("save_attachment");
    await h.close();
  });

  it("saves into the download folder without overwriting", async () => {
    const { h } = await setup();
    const first = await h.call("save_attachment", { uid: 1, attachmentIndex: 0 });
    const second = await h.call("save_attachment", { uid: 1, attachmentIndex: 0 });
    expect(first.json).toMatchObject({ saved: true, filename: "Rechnung.pdf", size: 10_000, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(path.basename(second.json.path)).toBe("Rechnung (1).pdf");
    expect((await readFile(first.json.path)).length).toBe(10_000);
    await h.close();
  });

  it("never saves executables, even with a disguised path-like name", async () => {
    const { h } = await setup();
    const res = await h.call("save_attachment", { uid: 1, attachmentIndex: 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not saved for safety/);
    await expect(readdir(path.join(dir, "downloads"))).rejects.toThrow(); // folder never created
    await h.close();
  });

  it("never saves executables hidden behind a trailing dot (saved name would end in .exe)", async () => {
    const { h } = await setup();
    const res = await h.call("save_attachment", { uid: 1, attachmentIndex: 2 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not saved for safety/);
    await expect(readdir(path.join(dir, "downloads"))).rejects.toThrow();
    await h.close();
  });

  it("explains when no download folder is configured", async () => {
    const { h } = await setup({});
    const res = await h.call("save_attachment", { uid: 1, attachmentIndex: 0 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/files\.downloadDir/);
    await h.close();
  });
});
