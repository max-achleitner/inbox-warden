import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { listFolderInfo } from "../imap/folders.js";
import { resolvePolicyFolder, visibleFolders } from "../policy/folder-access.js";
import { strictStatus } from "../imap/strict.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "get_email_count",
      title: "Count emails",
      description: "Get message counts (total and unread) for one or all folders",
      tier: "read",
      input: {
        folder: z.string().optional().describe("Specific folder path, or omit for all folders"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      errorPrefix: "Error getting email count",
    },
    async ({ folder }, inv) => {
      const client = await inv.account.getClient();

      if (folder) {
        const path = await resolvePolicyFolder(inv.account, client, folder);
        const status = await strictStatus(client, path, { messages: true, unseen: true });
        return jsonResult({ folder: path, total: status.messages ?? 0, unread: status.unseen ?? 0 });
      }

      // All folders; some virtual folders do not support STATUS and are reported as unavailable
      const folders: Array<{ path: string; total?: number; unread?: number; unavailable?: true }> = [];
      const selectable = (await listFolderInfo(client)).filter((f) => f.selectable);
      for (const info of visibleFolders(inv.account, selectable)) {
        try {
          const status = await strictStatus(client, info.path, { messages: true, unseen: true });
          folders.push({ path: info.path, total: status.messages ?? 0, unread: status.unseen ?? 0 });
        } catch {
          folders.push({ path: info.path, unavailable: true });
        }
      }
      return jsonResult(folders);
    },
  );
}
