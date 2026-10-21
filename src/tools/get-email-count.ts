import { z } from "zod";
import type { ImapFlow } from "imapflow";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { listFolderInfo } from "../imap/folders.js";
import { resolvePolicyFolder, visibleFolders } from "../policy/folder-access.js";
import { labelLockApplies } from "../policy/label-lock.js";
import { LABEL_SCAN_LIMIT } from "../imap/select.js";
import { strictSearch, strictStatus, visibleUids, type MessageScope } from "../imap/strict.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

interface Counts {
  total: number;
  unread: number;
}

async function statusCounts(client: ImapFlow, path: string): Promise<Counts> {
  const status = await strictStatus(client, path, { messages: true, unseen: true });
  return { total: status.messages ?? 0, unread: status.unseen ?? 0 };
}

/**
 * Exact counts without the messages the scope hides. STATUS would count them too, so the folder
 * is examined (read-only) and its messages' labels are checked. `budget` caps how many messages
 * one call checks; a folder that does not fit returns null and is not counted at all.
 */
async function visibleCounts(client: ImapFlow, path: string, scope: MessageScope, budget: { remaining: number }): Promise<Counts | null> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const exists = client.mailbox ? client.mailbox.exists : 0;
    if (exists === 0) return { total: 0, unread: 0 };
    if (exists > budget.remaining) return null;
    budget.remaining -= exists;
    const visible = new Set(await visibleUids(client, await strictSearch(client, { all: true }), scope));
    const unread = (await strictSearch(client, { seen: false })).filter((uid) => visible.has(uid)).length;
    return { total: visible.size, unread };
  } finally {
    try { lock.release(); } catch { /* connection may already be dead */ }
  }
}

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
      const folders = await listFolderInfo(client);
      // On Gmail with deny rules, STATUS would also count messages hidden by their labels
      const byLabels = labelLockApplies(client, inv.account.policy.policy.folders);
      const scope = inv.account.policy.messageScope(folders);
      const budget = { remaining: LABEL_SCAN_LIMIT };
      const count = (path: string) => (byLabels ? visibleCounts(client, path, scope, budget) : statusCounts(client, path));

      if (folder) {
        const path = await resolvePolicyFolder(inv.account, client, folder, folders);
        const counts = await count(path);
        if (!counts) {
          throw new Error(
            `"${path}" holds too many emails to count them without the ones this mailbox's folder locks hide (at most ${LABEL_SCAN_LIMIT} per call). ` +
              "Use search_emails with since/before to count a period instead.",
          );
        }
        return jsonResult({ folder: path, ...counts });
      }

      // All folders; some virtual folders do not support STATUS and are reported as unavailable
      const result: Array<{ path: string; total?: number; unread?: number; unavailable?: true }> = [];
      for (const info of visibleFolders(inv.account, folders.filter((f) => f.selectable))) {
        try {
          const counts = await count(info.path);
          result.push(counts ? { path: info.path, ...counts } : { path: info.path, unavailable: true });
        } catch {
          result.push({ path: info.path, unavailable: true });
        }
      }
      return jsonResult(result);
    },
  );
}
