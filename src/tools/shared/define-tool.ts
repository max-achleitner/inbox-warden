import { z } from "zod";
import {
  isInputRequiredResult,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { AccountRuntime, AppContext, ToolCallEvent } from "../../context.js";
import type { PermissionTier } from "../../config/schema.js";
import * as log from "../../logging/logger.js";
import { errorResult } from "./result.js";
import { PolicyDeniedError, tierAllowed, tierDenialMessage } from "../../policy/engine.js";
import { clientCapabilitiesOf } from "../../policy/confirm.js";

export interface ToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  tier: PermissionTier | "always";
  /** Tool parameters; an optional `account` parameter is added automatically. */
  input: S;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Prefix for error texts, e.g. "Error moving emails". */
  errorPrefix: string;
  meta?: Record<string, unknown>;
}

export interface ToolInvocation {
  tool: string;
  account: AccountRuntime;
  /** SDK handler context (elicitation, input responses, cancellation). */
  sdk: ServerContext;
  /** Add details for observers (audit log). Never pass message bodies or secrets. */
  record(details: Record<string, unknown>): void;
  /** Capabilities of the calling client (2026-07-28 request envelope, else the 2025-era handshake). */
  clientCapabilities(): ClientCapabilities | undefined;
}

export type ToolHandler<S extends z.ZodRawShape> = (
  args: z.output<z.ZodObject<S>>,
  inv: ToolInvocation,
) => Promise<CallToolResult | InputRequiredResult>;

function accountParam(app: AppContext) {
  const ids = [...app.accounts.keys()];
  const description =
    ids.length > 1
      ? `Mail account: ${ids.map((id) => `"${id}"`).join(", ")}. Default: "${app.defaultAccountId}". Use list_accounts to see addresses.`
      : `Mail account id (only "${ids[0]}" is configured, so this can be omitted)`;
  return z.string().optional().describe(description);
}

function textOf(result: CallToolResult): string | undefined {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : undefined;
}

async function notifyObservers(app: AppContext, event: ToolCallEvent): Promise<void> {
  for (const observer of app.observers) {
    try {
      await observer.onToolCall(event);
    } catch (err) {
      log.error("observer.failed", { tool: event.tool }, err);
    }
  }
}

/**
 * The single registration path for every tool: adds the `account` parameter, registers the tool only
 * when some account grants its tier, checks the tier of the selected account on every call, maps
 * exceptions to plain-language errors and notifies observers (audit log in Plan 5).
 */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  app: AppContext,
  spec: ToolSpec<S>,
  handler: ToolHandler<S>,
): void {
  if (spec.tier !== "always" && !app.anyAccountAllows(spec.tier)) return;

  // Strict: an unknown parameter (typo, stale client schema) fails instead of being dropped, because a
  // dropped filter widens the selection — up to the whole folder.
  const inputSchema = z.strictObject({ ...spec.input, account: accountParam(app) });

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema,
      annotations: { title: spec.title, ...spec.annotations },
      ...(spec.meta ? { _meta: spec.meta } : {}),
    },
    async (args, ctx) => {
      const started = Date.now();
      const details: Record<string, unknown> = {};
      const { account: accountArg, ...rest } = args as { account?: string } & Record<string, unknown>;
      let accountId = accountArg ?? app.defaultAccountId;
      let outcome: ToolCallEvent["outcome"] = "success";
      let result: CallToolResult;

      try {
        const account = app.resolveAccount(accountArg);
        accountId = account.id;
        if (spec.tier !== "always" && !tierAllowed(account.config, spec.tier)) {
          outcome = "denied";
          result = errorResult(spec.errorPrefix, tierDenialMessage(account.config, spec.tier));
        } else {
          const handled = await handler(rest as z.output<z.ZodObject<S>>, {
            tool: spec.name,
            account,
            sdk: ctx,
            record: (d) => Object.assign(details, d),
            clientCapabilities: () => clientCapabilitiesOf(server, ctx),
          });
          // A confirmation round is not a finished call: no observers, no audit record
          if (isInputRequiredResult(handled)) return handled;
          result = handled;
          if (result.isError) outcome = "error";
        }
      } catch (err) {
        outcome = err instanceof PolicyDeniedError ? "denied" : "error";
        result = errorResult(spec.errorPrefix, err);
      }

      await notifyObservers(app, {
        tool: spec.name,
        accountId,
        tier: spec.tier,
        outcome,
        durationMs: Date.now() - started,
        details,
        ...(outcome !== "success" ? { error: textOf(result) } : {}),
      });
      return result;
    },
  );
}
