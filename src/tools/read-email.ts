import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import { errorMessage } from "../errors.js";
import * as log from "../logging/logger.js";
import { scanForInjection } from "../security/injection-detector.js";
import { recordScan } from "./health-check.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "read_email",
    "Read the full content of an email by UID",
    {
      folder: z.string().default("INBOX").describe("Mailbox folder path"),
      uid: z.number().describe("Email UID from search results"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ folder, uid }) => {
      try {
        const client = await getClient();
        const lock = await client.getMailboxLock(folder);

        try {
          const raw = await client.download(uid.toString(), undefined, { uid: true });
          const parsed = await simpleParser(raw.content);

          // Full injection scan: subject + body + html + attachment names
          const _injectionScan = scanForInjection({
            subject: parsed.subject,
            body: parsed.text || undefined,
            html: parsed.html || undefined,
            attachmentNames: parsed.attachments?.map((a) => a.filename).filter(Boolean) as string[],
          });
          recordScan(_injectionScan.hasInjection);
          if (_injectionScan.hasInjection) {
            log.warn("injection.detected", {
              uid,
              folder,
              riskLevel: _injectionScan.riskLevel,
              findingCount: _injectionScan.findings.length,
              types: [...new Set(_injectionScan.findings.map((f) => f.type))],
            });
          }

          // Generate plaintext from HTML if no text body
          let text = parsed.text || "";
          let textGenerated = false;
          if (!text && parsed.html) {
            text = convert(parsed.html, {
              wordwrap: 120,
              selectors: [
                { selector: "a", options: { linkBrackets: ["[", "]"] } },
                { selector: "img", format: "skip" },
              ],
            });
            textGenerated = true;
          }

          const result: any = {
            uid,
            subject: parsed.subject,
            from: parsed.from?.value,
            to: parsed.to
              ? (Array.isArray(parsed.to) ? parsed.to.flatMap((t) => t.value) : parsed.to.value)
              : [],
            cc: parsed.cc
              ? (Array.isArray(parsed.cc) ? parsed.cc.flatMap((c) => c.value) : parsed.cc.value)
              : [],
            date: parsed.date?.toISOString(),
            text,
            ...(textGenerated ? { textGenerated: true } : {}),
            html: parsed.html || undefined,
            attachments: parsed.attachments?.map((a, index) => ({
              index,
              filename: a.filename,
              contentType: a.contentType,
              size: a.size,
            })),
            _injectionScan,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } finally {
          lock.release();
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error reading email: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
