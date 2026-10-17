import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { errorMessage } from "../errors.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

const NOT_SUPPORTED = { supported: false, note: "This mail server does not report storage quotas." };

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "get_quota",
      title: "Mailbox storage quota",
      description: "Get mailbox storage quota (usage and limits). Not all IMAP servers support this.",
      tier: "read",
      input: {
        path: z.string().optional().describe("Quota root path (usually omit for default)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      errorPrefix: "Error getting quota",
    },
    async ({ path }, inv) => {
      const client = await inv.account.getClient();
      // Without a path imapflow asks for the account's default quota root (via INBOX)
      const folder = path === undefined ? undefined : await resolvePolicyFolder(inv.account, client, path);
      let quota;
      try {
        quota = await client.getQuota(folder);
      } catch (error) {
        const msg = errorMessage(error).toLowerCase();
        if (msg.includes("quota") || msg.includes("not supported") || msg.includes("unknown command")) {
          return jsonResult(NOT_SUPPORTED);
        }
        throw error;
      }
      if (!quota) return jsonResult(NOT_SUPPORTED);

      const result: Record<string, unknown> = { path: quota.path };
      if (quota.storage) {
        result.usage = quota.storage.usage;
        result.limit = quota.storage.limit;
        const { usage, limit } = quota.storage;
        if (usage !== undefined && limit !== undefined && limit > 0) {
          result.usagePercent = Math.round((usage / limit) * 10000) / 100;
        }
      }
      if (quota.message) {
        result.messageCount = quota.message.usage;
        result.messageLimit = quota.message.limit;
      }
      if (!quota.storage && !quota.message) {
        Object.assign(result, { supported: false, note: "The server returned a quota root but no storage or message limits." });
      }
      return jsonResult(result);
    },
  );
}
