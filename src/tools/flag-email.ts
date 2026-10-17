import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { resolvePolicyFolder } from "../policy/folder-access.js";
import { existingUids, strictStoreFlags, unsupportedFlags } from "../imap/strict.js";
import { normalizeFlag, uniqueUids } from "../imap/flags.js";
import { defineTool } from "./shared/define-tool.js";
import { errorResult, jsonResult } from "./shared/result.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "flag_email",
      title: "Flag emails",
      description:
        "Add or remove flags on emails: \\Seen, \\Answered, \\Flagged, \\Draft, or custom keywords like $Done. " +
        "Custom keywords fail with an error on servers that do not support them (e.g. Microsoft Exchange). " +
        "Deleting is not possible here; use delete_email.",
      tier: "write",
      input: {
        folder: z.string().default("INBOX").describe("Mailbox folder path"),
        uids: z.array(z.number().int().positive()).min(1).max(1000).describe("Email UIDs to modify"),
        action: z.enum(["add", "remove"]).describe("Whether to add or remove the flags"),
        flags: z.array(z.string()).min(1).describe('Flags to set, e.g. ["\\\\Flagged", "$Done"]'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      errorPrefix: "Error flagging emails",
    },
    async ({ folder, uids, action, flags }, inv) => {
      const normalized = [...new Set(flags.map(normalizeFlag))];
      if (action === "add" && normalized.includes("\\Deleted")) {
        return errorResult(
          "Error flagging emails",
          "flag_email cannot mark messages as deleted. Use delete_email, which requires the delete permission.",
        );
      }

      const client = await inv.account.getClient();
      const path = await resolvePolicyFolder(inv.account, client, folder);
      const lock = await client.getMailboxLock(path);
      try {
        if (action === "add") {
          const unsupported = unsupportedFlags(client.mailbox, normalized);
          if (unsupported.length > 0) {
            return errorResult(
              "Error flagging emails",
              `This mail server does not support the keyword(s) ${unsupported.join(", ")} in "${path}" (common on Microsoft Exchange). ` +
                "Use \\Flagged or move the emails into a folder instead. Nothing was changed.",
            );
          }
        }

        const requested = uniqueUids(uids);
        const present = await existingUids(client, requested);
        const missingUids = requested.filter((u) => !present.includes(u));
        if (present.length === 0) {
          return errorResult("Error flagging emails", `None of the UIDs exist in "${path}". Nothing was changed.`);
        }

        inv.account.policy.checkBulk(present.length, "flag");
        await strictStoreFlags(client, present, normalized, action);
        inv.record({ folder: path, uids: present, action, flags: normalized });
        return jsonResult({
          success: true,
          folder: path,
          uids: present,
          action,
          flags: normalized,
          ...(missingUids.length > 0 ? { missingUids } : {}),
        });
      } finally {
        try { lock.release(); } catch { /* connection may already be dead */ }
      }
    },
  );
}
