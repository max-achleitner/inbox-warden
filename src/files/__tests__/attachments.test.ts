import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { contentTypeFor, outgoingAttachmentsSchema, resolveOutgoingAttachments } from "../attachments.js";

describe("resolveOutgoingAttachments", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "imap-mcp-att-"));
    await writeFile(path.join(dir, "Angebot_Größe.pdf"), "%PDF-1.7");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a file from an allowed folder and derives name and type", async () => {
    const [att] = (await resolveOutgoingAttachments({ attachmentDirs: [dir] }, [{ path: "Angebot_Größe.pdf" }]))!;
    expect(att.filename).toBe("Angebot_Größe.pdf");
    expect(att.contentType).toBe("application/pdf");
    expect(Buffer.from(att.content, "base64").toString()).toBe("%PDF-1.7");
  });

  it("refuses a folder instead of a file", async () => {
    await mkdir(path.join(dir, "Ordner"));
    await expect(resolveOutgoingAttachments({ attachmentDirs: [dir] }, [{ path: "Ordner" }])).rejects.toThrow(/"Ordner" is not a file/);
  });

  it.skipIf(process.platform === "win32")("refuses a named pipe without waiting for a writer", async () => {
    execFileSync("mkfifo", [path.join(dir, "pipe")]);
    await expect(resolveOutgoingAttachments({ attachmentDirs: [dir] }, [{ path: "pipe" }])).rejects.toThrow(/"pipe" is not a file/);
  });

  it("accepts base64 attachments as before", async () => {
    const [att] = (await resolveOutgoingAttachments({ attachmentDirs: [] }, [
      { filename: "a.txt", content: Buffer.from("hi").toString("base64"), contentType: "text/plain" },
    ]))!;
    expect(att.filename).toBe("a.txt");
  });

  it("refuses file paths when no attachment folder is configured", async () => {
    await expect(resolveOutgoingAttachments({ attachmentDirs: [] }, [{ path: path.join(dir, "Angebot_Größe.pdf") }])).rejects.toThrow(
      /files\.attachmentDirs/,
    );
  });

  it("rejects invalid base64 and path-like filenames", async () => {
    await expect(resolveOutgoingAttachments({ attachmentDirs: [] }, [{ filename: "a.txt", content: "%%%", contentType: "text/plain" }])).rejects.toThrow(
      /invalid base64/,
    );
    await expect(resolveOutgoingAttachments({ attachmentDirs: [] }, [{ filename: "../a.txt", content: "", contentType: "text/plain" }])).rejects.toThrow(
      /Invalid attachment filename/,
    );
  });

  it("schema distinguishes path and base64 entries", () => {
    const parsed = outgoingAttachmentsSchema.parse([{ path: "a.pdf" }, { filename: "b.txt", content: "aGk=", contentType: "text/plain" }]);
    expect(parsed).toEqual([{ path: "a.pdf" }, { filename: "b.txt", content: "aGk=", contentType: "text/plain" }]);
  });

  it("maps common extensions", () => {
    expect(contentTypeFor("Tabelle.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
});
