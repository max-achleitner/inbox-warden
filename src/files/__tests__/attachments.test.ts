import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { contentTypeFor, outgoingAttachmentsSchema, resolveOutgoingAttachments } from "../attachments.js";

// Lets a test act like a second local process that changes the file system around the open.
const race = vi.hoisted(() => ({
  beforeOpen: undefined as (() => Promise<void>) | undefined,
  afterOpen: undefined as ((handle: FileHandle) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await race.beforeOpen?.();
      const handle = await actual.open(...args);
      await race.afterOpen?.(handle);
      return handle;
    },
  };
});

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

  describe("when the file system changes between the check and the read", () => {
    let outside: string;
    const sub = () => path.join(dir, "sub");

    beforeEach(async () => {
      outside = await mkdtemp(path.join(os.tmpdir(), "imap-mcp-outside-"));
      await mkdir(sub());
      await writeFile(path.join(sub(), "doc.pdf"), "inside");
      await mkdir(path.join(outside, "sub"));
      await writeFile(path.join(outside, "sub", "doc.pdf"), "SECRET");
    });

    afterEach(async () => {
      race.beforeOpen = undefined;
      race.afterOpen = undefined;
      await rm(outside, { recursive: true, force: true });
    });

    /** Replace the checked folder `sub` with a link to the same-named folder outside. */
    async function swapInLink(): Promise<void> {
      await rename(sub(), `${sub()}-old`);
      await symlink(path.join(outside, "sub"), sub(), process.platform === "win32" ? "junction" : "dir");
    }

    async function swapBack(): Promise<void> {
      await unlink(sub());
      await rename(`${sub()}-old`, sub());
    }

    it("refuses when a folder on the checked path became a link to a folder outside", async () => {
      race.beforeOpen = swapInLink;
      await expect(resolveOutgoingAttachments({ attachmentDirs: [dir] }, [{ path: "sub/doc.pdf" }])).rejects.toThrow(
        /"sub\/doc.pdf" changed while it was being attached\. Nothing was attached\./,
      );
    });

    it("refuses when the link is swapped back right after the open", async () => {
      race.beforeOpen = swapInLink;
      race.afterOpen = swapBack;
      await expect(resolveOutgoingAttachments({ attachmentDirs: [dir] }, [{ path: "sub/doc.pdf" }])).rejects.toThrow(
        /"sub\/doc.pdf" changed while it was being attached/,
      );
    });

    it.each([
      ["grows past the size limit", (file: string) => appendFile(file, Buffer.alloc(26 * 1024 * 1024))],
      ["shrinks", (file: string) => truncate(file, 2)],
    ])("refuses a file that %s after its size was checked", async (_name, change) => {
      const file = path.join(sub(), "doc.pdf");
      race.afterOpen = async (handle) => {
        const realStat = handle.stat.bind(handle);
        let changed = false;
        handle.stat = (async (...args: Parameters<FileHandle["stat"]>) => {
          const stats = await realStat(...args);
          if (!changed) {
            changed = true;
            await change(file);
          }
          return stats;
        }) as FileHandle["stat"];
      };
      await expect(resolveOutgoingAttachments({ attachmentDirs: [dir] }, [{ path: "sub/doc.pdf" }])).rejects.toThrow(
        /"sub\/doc.pdf" changed while it was being attached/,
      );
    });
  });

  it("maps common extensions", () => {
    expect(contentTypeFor("Tabelle.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
});
