import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { SignInManager } from "../auth/oauth/sign-in-manager.js";
import { defineTool } from "./shared/define-tool.js";
import { errorResult, jsonResult } from "./shared/result.js";

/** One sign_in call waits this long for the browser; stays below common MCP client request timeouts. */
export const SIGN_IN_WAIT_MS = 45_000;

export function register(server: McpServer, app: AppContext, manager = new SignInManager({ secrets: app.secrets })) {
  defineTool(
    server,
    app,
    {
      name: "sign_in",
      title: "Sign in to a mailbox",
      description:
        "Sign in to a Microsoft 365 / Outlook.com or Google mailbox that uses browser sign-in. Opens the sign-in page " +
        "in the browser on this computer and returns the link. If the result says \"waiting\", the user finishes the " +
        "sign-in in the browser and you call sign_in again. Not needed for mailboxes that use a password.",
      tier: "always",
      input: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      errorPrefix: "Error signing in",
    },
    async (_args, inv) => {
      const account = inv.account.config;
      const status = await manager.signIn(account, SIGN_IN_WAIT_MS);
      inv.record({ action: "sign_in", outcome: status.state });
      switch (status.state) {
        case "not_needed":
          return jsonResult({ status: "not_needed", message: `${account.email} signs in with a password; no browser sign-in is needed.` });
        case "signed_in":
          return jsonResult({ status: "signed_in", message: `Signed in to ${account.email}. The mailbox can be used now.` });
        case "waiting":
          return jsonResult({
            status: "waiting",
            signInUrl: status.url,
            expiresAt: new Date(status.expiresAt).toISOString(),
            message:
              "The sign-in page was opened in the browser on this computer (if not, open signInUrl). " +
              "After signing in there, ask me to run sign_in again to finish.",
          });
        case "failed":
          return errorResult("Error signing in", status.error);
      }
    },
  );
}
