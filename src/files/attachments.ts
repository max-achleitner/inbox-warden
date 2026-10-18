import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { OutgoingAttachment } from "../mail/compose.js";
import { SandboxError, resolveInside } from "./sandbox.js";

export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024; // 25MB

const pathAttachment = z.strictObject({
  path: z.string().min(1).describe("File in one of the configured attachment folders (relative to the folder, or absolute)"),
  filename: z.string().min(1).optional().describe("Name shown to the recipient (default: the file name)"),
  contentType: z.string().min(1).optional().describe("MIME type (default: derived from the file extension)"),
});

const base64Attachment = z.strictObject({
  filename: z.string().describe("Attachment filename"),
  content: z.string().describe("Base64-encoded file content"),
  contentType: z.string().describe("MIME type, e.g. application/pdf"),
});

export const outgoingAttachmentsSchema = z
  .array(z.union([pathAttachment, base64Attachment]))
  .max(20)
  .optional()
  .describe('Attachments: { path } for a file in an allowed folder (preferred), or { filename, content (base64), contentType }');

export type OutgoingAttachmentInput = z.infer<typeof pathAttachment> | z.infer<typeof base64Attachment>;

export interface AttachmentFolders {
  attachmentDirs: string[];
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  xml: "application/xml",
  json: "application/json",
  ics: "text/calendar",
  eml: "message/rfc822",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** O_NONBLOCK keeps a FIFO from blocking the open; Windows refuses directories with EISDIR. */
async function openForReading(real: string, shown: string): Promise<FileHandle> {
  try {
    return await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      throw new SandboxError(`"${shown}" is not a file. Nothing was attached.`);
    }
    throw err;
  }
}

function checkFilename(filename: string): void {
  if (/[/\\]|\.\./.test(filename)) {
    throw new SandboxError(`Invalid attachment filename "${filename}" — must not contain /, \\, or .. Nothing was attached.`);
  }
}

/**
 * Turn attachment inputs into composer attachments. File paths must resolve inside
 * `files.attachmentDirs`; the total size is capped at 25 MB.
 */
export async function resolveOutgoingAttachments(
  files: AttachmentFolders,
  inputs: OutgoingAttachmentInput[] | undefined,
): Promise<OutgoingAttachment[] | undefined> {
  if (!inputs || inputs.length === 0) return undefined;
  const result: OutgoingAttachment[] = [];
  let totalBytes = 0;
  for (const input of inputs) {
    if ("path" in input) {
      const real = await resolveInside(files.attachmentDirs, input.path);
      // Size check and read go through one handle, so the file cannot be swapped in between.
      const handle = await openForReading(real, input.path);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new SandboxError(`"${input.path}" is not a file. Nothing was attached.`);
        totalBytes += info.size;
        if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) break;
        const filename = input.filename ?? path.basename(real);
        checkFilename(filename);
        result.push({
          filename,
          content: (await handle.readFile()).toString("base64"),
          contentType: input.contentType ?? contentTypeFor(filename),
        });
      } finally {
        await handle.close();
      }
    } else {
      checkFilename(input.filename);
      const clean = input.content.replace(/\s/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
        throw new SandboxError(`Attachment "${input.filename}" contains invalid base64 content. Nothing was attached.`);
      }
      totalBytes += Math.ceil((clean.length * 3) / 4);
      result.push({ filename: input.filename, content: clean, contentType: input.contentType });
    }
  }
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new SandboxError(
      `Attachments total more than ${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB, which most mail servers reject. Nothing was attached.`,
    );
  }
  return result;
}
