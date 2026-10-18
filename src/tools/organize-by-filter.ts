import { z } from "zod";
import type { ImapFlow } from "imapflow";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AccountRuntime, AppContext } from "../context.js";
import { listFolderInfo, type FolderInfo } from "../imap/folders.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { checkTrashMove, movesIntoTrash } from "../policy/trash-move.js";
import { normalizeFlag } from "../imap/flags.js";
import { strictMove, strictStoreFlags, unsupportedFlags } from "../imap/strict.js";
import { searchFilterShape } from "../imap/search-query.js";
import { commitBulk, previewBulk } from "../bulk/run.js";
import type { BulkAction } from "../bulk/selection.js";
import { defineTool } from "./shared/define-tool.js";
import { uidMappingFields } from "./shared/uid-mapping.js";

const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("move"), destination: z.string().min(1).describe("Destination folder") }),
  z.strictObject({ type: z.literal("markRead") }),
  z.strictObject({ type: z.literal("markUnread") }),
  z.strictObject({ type: z.literal("flag") }),
  z.strictObject({ type: z.literal("unflag") }),
  z.strictObject({ type: z.literal("addKeyword"), keyword: z.string().min(1).describe("Custom keyword, e.g. $Done") }),
  z.strictObject({ type: z.literal("removeKeyword"), keyword: z.string().min(1).describe("Custom keyword, e.g. $Done") }),
]);

type ActionInput = z.infer<typeof actionSchema>;

/** Resolve folder names and keyword spelling so preview and commit compare identical actions. */
async function canonicalAction(
  account: AccountRuntime,
  client: ImapFlow,
  folders: FolderInfo[],
  source: string,
  action: ActionInput,
): Promise<BulkAction> {
  switch (action.type) {
    case "move": {
      const destination = await resolvePolicyFolder(account, client, action.destination, folders);
      if (destination === source) {
        throw new Error(`Source and destination are the same folder ("${source}"). Nothing was changed.`);
      }
      if (movesIntoTrash(folders, destination)) {
        checkTrashMove(account);
        return { type: "move", destination, intoTrash: true };
      }
      return { type: "move", destination };
    }
    case "addKeyword":
    case "removeKeyword": {
      const keyword = normalizeFlag(action.keyword);
      if (keyword.startsWith("\\")) {
        throw new Error(`"${action.keyword}" is a system flag, not a keyword. Use markRead, markUnread, flag or unflag instead. Nothing was changed.`);
      }
      return { type: action.type, keyword };
    }
    case "markRead":
      return { type: "markRead" };
    case "markUnread":
      return { type: "markUnread" };
    case "flag":
      return { type: "flag" };
    case "unflag":
      return { type: "unflag" };
  }
}

function checkKeywordStorable(client: ImapFlow, action: BulkAction): void {
  if (action.type !== "addKeyword") return;
  if (unsupportedFlags(client.mailbox, [action.keyword]).length > 0) {
    throw new Error(
      `This mail server does not support the keyword ${action.keyword} in this folder (common on Microsoft Exchange). Use flag or move the emails into a folder instead. Nothing was changed.`,
    );
  }
}

async function applyAction(client: ImapFlow, uids: number[], action: BulkAction): Promise<Record<string, unknown>> {
  switch (action.type) {
    case "move": {
      const uidMap = await strictMove(client, uids, action.destination);
      return { destination: action.destination, ...uidMappingFields(uidMap, action.destination) };
    }
    case "markRead":
      await strictStoreFlags(client, uids, ["\\Seen"], "add");
      return {};
    case "markUnread":
      await strictStoreFlags(client, uids, ["\\Seen"], "remove");
      return {};
    case "flag":
      await strictStoreFlags(client, uids, ["\\Flagged"], "add");
      return {};
    case "unflag":
      await strictStoreFlags(client, uids, ["\\Flagged"], "remove");
      return {};
    case "addKeyword":
      checkKeywordStorable(client, action);
      await strictStoreFlags(client, uids, [action.keyword], "add");
      return { keyword: action.keyword };
    case "removeKeyword":
      await strictStoreFlags(client, uids, [action.keyword], "remove");
      return { keyword: action.keyword };
    case "delete":
      throw new Error("Use delete_email to delete messages. Nothing was changed.");
  }
}

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "organize_by_filter",
      title: "Organize all emails matching a filter",
      description:
        "Move, mark read/unread, flag/unflag, or add/remove a keyword on ALL emails in a folder that match a filter (same filters as search_emails). " +
        "Two steps: a call WITHOUT confirmToken only previews (count, sample, confirmToken) and changes nothing — show the preview to the user. " +
        "Then call again with the same folder and action plus confirmToken; it applies to exactly the previewed messages and expires after 10 minutes. " +
        'For the whole folder pass the filter {"all": true}; a filter without any criterion is refused.',
      tier: "write",
      input: {
        folder: z.string().default("INBOX").describe("Folder to select messages from"),
        filter: z.strictObject(searchFilterShape).describe("Which messages, e.g. {\"from\": \"newsletter@shop.example\", \"before\": \"2026-01-01\"}"),
        action: actionSchema.describe("What to do with the matching messages"),
        confirmToken: z.string().min(1).optional().describe("Token from the preview; only send it after the user agreed"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      errorPrefix: "Error organizing emails",
    },
    async ({ folder, filter, action, confirmToken }, inv) => {
      const client = await inv.account.getClient();
      const folders = await listFolderInfo(client);
      const source = await resolvePolicyFolder(inv.account, client, folder, folders);
      const canonical = await canonicalAction(inv.account, client, folders, source, action);
      if (!confirmToken) {
        return previewBulk(app, inv, {
          folder: source,
          filters: filter,
          action: canonical,
          validate: (c) => checkKeywordStorable(c, canonical),
        });
      }
      return commitBulk(app, inv, {
        token: confirmToken,
        folder: source,
        action: canonical,
        apply: (c, uids) => applyAction(c, uids, canonical),
      });
    },
  );
}
