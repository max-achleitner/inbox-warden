import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { errorMessage } from "../errors.js";

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

          const result = {
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
            text: parsed.text || "",
            html: parsed.html || undefined,
            attachments: parsed.attachments?.map((a, index) => ({
              index,
              filename: a.filename,
              contentType: a.contentType,
              size: a.size,
            })),
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
