import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { parseMail } from "../mail/parse.js";
import type { AppContext } from "../context.js";
import { scanForInjection } from "../security/injection-detector.js";
import { listFolderInfo } from "../imap/folders.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { downloadMessage } from "../imap/strict.js";
import { resolveDownloadTarget } from "../files/sandbox.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "save_attachment",
      title: "Save an email attachment to disk",
      description:
        "Save one attachment of an email (index from read_email) into the configured download folder (files.downloadDir) and return the saved path. " +
        "Existing files are never overwritten (a number is appended). Executable, script and macro files are never saved.",
      tier: "write",
      input: {
        folder: z.string().default("INBOX").describe("Mailbox folder path"),
        uid: z.number().int().positive().describe("Email UID"),
        attachmentIndex: z.number().int().min(0).describe("Attachment index (0-based, from read_email results)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      errorPrefix: "Error saving attachment",
    },
    async ({ folder, uid, attachmentIndex }, inv) => {
      const client = await inv.account.getClient();
      const folders = await listFolderInfo(client);
      const path = await resolvePolicyFolder(inv.account, client, folder, folders);
      const lock = await client.getMailboxLock(path);
      let parsed;
      try {
        parsed = await parseMail(await downloadMessage(client, uid, path, inv.account.policy.messageScope(folders)));
      } finally {
        try { lock.release(); } catch { /* connection may already be dead */ }
      }

      const attachment = parsed.attachments[attachmentIndex];
      if (!attachment) {
        throw new Error(`No attachment at index ${attachmentIndex}. Email has ${parsed.attachments.length} attachments. Nothing was saved.`);
      }
      const filename = attachment.filename || `attachment_${attachmentIndex}`;
      // Size limit and executable/macro file types (policy.attachments.blockExecutables, on by default)
      inv.account.policy.checkAttachment(filename, attachment.size, true);
      const target = await resolveDownloadTarget(app.config.files.downloadDir, filename);
      await writeFile(target, attachment.content, { flag: "wx", mode: 0o600 });
      await markAsDownloaded(target);
      const sha256 = createHash("sha256").update(attachment.content).digest("hex");
      const nameScan = scanForInjection({ attachmentNames: [filename] });
      inv.record({ injectionRisk: nameScan.riskLevel });

      inv.record({ folder: path, uids: [uid], action: "save_attachment" });
      return jsonResult({
        saved: true,
        path: target,
        filename,
        contentType: attachment.contentType,
        size: attachment.size,
        sha256,
        ...(nameScan.hasInjection ? { _injectionScan: nameScan } : {}),
      });
    },
  );
}

/**
 * Windows' Mark of the Web: Office then blocks macros from the internet, and SmartScreen and the
 * help viewer treat the file as downloaded, whatever its extension.
 */
async function markAsDownloaded(file: string): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    await writeFile(`${file}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  } catch {
    // FAT drives and some network shares have no alternate data streams; the file stays unmarked
  }
}
