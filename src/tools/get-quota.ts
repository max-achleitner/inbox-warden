import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "get_quota",
    "Get mailbox storage quota (usage and limits). Not all IMAP servers support this.",
    {
      path: z.string().optional().describe("Quota root path (usually omit for default)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ path }) => {
      try {
        const client = await getClient();
        const quota = await client.getQuota(path);

        if (quota === false) {
          return {
            content: [{ type: "text", text: "QUOTA not supported by this IMAP server" }],
            isError: true,
          };
        }

        const result: any = {
          path: quota.path,
        };

        if (quota.storage) {
          result.usage = quota.storage.used;
          result.limit = quota.storage.limit;
          result.usagePercent = quota.storage.limit > 0
            ? Math.round((quota.storage.used / quota.storage.limit) * 10000) / 100
            : 0;
        }

        if (quota.messages) {
          result.messageCount = quota.messages.used;
          result.messageLimit = quota.messages.limit;
        }

        if (!quota.storage && !quota.messages) {
          result.supported = false;
          result.note = "Server returned quota root but no storage or message limits. The server may not enforce quotas.";
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = errorMessage(error);
        if (msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("not supported") || msg.toLowerCase().includes("unknown command")) {
          return {
            content: [{ type: "text", text: "QUOTA not supported by this IMAP server" }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Error getting quota: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
