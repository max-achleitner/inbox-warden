import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { simpleParser } from "mailparser";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as createDraft from "../create-draft.js";

describe("create_draft with file attachments", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "imap-mcp-files-"));
    await writeFile(path.join(dir, "Angebot_Größe.pdf"), "%PDF-1.7");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("attaches a file from an allowed folder", async () => {
    const t = createTestApp(undefined, { files: { attachmentDirs: [dir] } });
    const h = await t.connect(createDraft.register);
    const res = await h.call("create_draft", {
      to: "kunde@example.com",
      subject: "Angebot",
      body: "Anbei.",
      attachments: [{ path: "Angebot_Größe.pdf" }],
    });
    expect(res.isError).toBe(false);
    const draft = await simpleParser(t.imap().message("Drafts", res.json.uid)!.raw);
    expect(draft.attachments[0]).toMatchObject({ filename: "Angebot_Größe.pdf", contentType: "application/pdf" });
    expect(draft.attachments[0].content.toString()).toBe("%PDF-1.7");
    await h.close();
  });

  it("refuses files when no attachment folder is configured and creates no draft", async () => {
    const t = createTestApp();
    const h = await t.connect(createDraft.register);
    const res = await h.call("create_draft", {
      to: "kunde@example.com",
      subject: "Angebot",
      body: "Anbei.",
      attachments: [{ path: path.join(dir, "Angebot_Größe.pdf") }],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/files\.attachmentDirs/);
    expect(t.imap().uidsIn("Drafts")).toEqual([]);
    await h.close();
  });

  it("refuses a path that escapes the allowed folder", async () => {
    const t = createTestApp(undefined, { files: { attachmentDirs: [path.join(dir, "sub")] } });
    const h = await t.connect(createDraft.register);
    const res = await h.call("create_draft", {
      to: "kunde@example.com",
      subject: "x",
      body: "x",
      attachments: [{ path: "../Angebot_Größe.pdf" }],
    });
    expect(res.isError).toBe(true);
    await h.close();
  });
});
