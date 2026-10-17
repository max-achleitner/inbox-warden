import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "list_accounts",
      title: "List mail accounts",
      description:
        "List the configured mail accounts with their sender addresses and what each is allowed to do. " +
        "Pass an account's id as the `account` parameter of other tools.",
      tier: "always",
      input: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      errorPrefix: "Error listing accounts",
    },
    async () =>
      jsonResult(
        [...app.accounts.values()].map((account) => ({
          id: account.id,
          ...(account.config.label ? { label: account.config.label } : {}),
          email: account.config.email,
          default: account.id === app.defaultAccountId,
          senders: account.ownAddresses,
          permissions: account.config.permissions,
          canSend: account.config.permissions.send && account.config.smtp !== undefined,
        })),
      ),
  );
}
