import { z } from "zod";
import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  inputRequired,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { ToolInvocation } from "../tools/shared/define-tool.js";
import { mintConfirmationState, redeemConfirmationState } from "./confirm-state.js";

export const CONFIRM_KEY = "imap_mcp_confirm";

const ConfirmSchema = z.object({
  confirm: z.boolean().describe("Yes, do it"),
});

export interface ConfirmationRequest {
  /** Plain-language summary shown in the client's dialog. */
  message: string;
  /** operationDigest() of exactly what will happen; the answer is only valid for this digest. */
  digest: string;
  /** true: refuse when the client cannot ask the user. false: rely on the client's own tool approval. */
  required: boolean;
}

export type ConfirmationOutcome =
  | { status: "confirmed" }
  | { status: "client-approval" }
  | { status: "pending"; result: InputRequiredResult }
  | { status: "refused"; reason: string };

/** Capabilities of the calling client: the 2026-07-28 request envelope, else the 2025-era handshake. */
export function clientCapabilitiesOf(server: McpServer, ctx: ServerContext): ClientCapabilities | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const fromRequest = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  return fromRequest ?? server.server.getClientCapabilities();
}

/** Form elicitation is declared explicitly ({ form: {} }) or, for older clients, as an empty object. */
export function supportsFormElicitation(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation as Record<string, unknown> | undefined;
  if (!elicitation) return false;
  return elicitation.form !== undefined || Object.keys(elicitation).length === 0;
}

/**
 * Ask the human — through the client, never through the model — to confirm one exact operation.
 *
 * Round 1 returns an input_required result (the SDK's legacy shim turns it into a classic
 * elicitation request for 2025-era clients). Round 2 (the client's retry) carries the answer
 * plus our HMAC-protected requestState, which must match the digest of the operation the
 * handler is about to perform *now* and is accepted only once. Declined, cancelled, missing,
 * mismatched or replayed answers are all "not confirmed".
 */
export function requireConfirmation(
  inv: Pick<ToolInvocation, "sdk" | "clientCapabilities">,
  request: ConfirmationRequest,
): ConfirmationOutcome {
  const responses = inv.sdk.mcpReq.inputResponses;
  if (responses && CONFIRM_KEY in responses) {
    const answer = acceptedContent(responses, CONFIRM_KEY, ConfirmSchema);
    if (!answer) {
      return { status: "refused", reason: "The confirmation was declined or cancelled. Nothing was sent or changed." };
    }
    if (answer.confirm !== true) {
      return { status: "refused", reason: "You did not confirm. Nothing was sent or changed." };
    }
    const state = inv.sdk.mcpReq.requestState<string>();
    if (typeof state !== "string" || !redeemConfirmationState(state, request.digest)) {
      return {
        status: "refused",
        reason:
          "The confirmation does not match this exact action (it changed, the dialog expired, or this confirmation was already used). " +
          "Nothing was sent or changed; please start again.",
      };
    }
    return { status: "confirmed" };
  }

  const capabilities = inv.clientCapabilities();
  if (capabilities === undefined) {
    // Stateless HTTP with a 2025-era client: no initialize was seen, so we cannot know whether the
    // client asks the user, and a dialog could not be delivered anyway. Never assume an approval.
    return {
      status: "refused",
      reason:
        "This action needs your confirmation, but the server cannot tell whether your app can show a confirmation dialog " +
        "(older MCP protocol over HTTP). Nothing was sent or changed. Create a draft instead and send it from your mail program.",
    };
  }
  if (!supportsFormElicitation(capabilities)) {
    if (request.required) {
      return {
        status: "refused",
        reason:
          "This action needs your explicit confirmation, but this app cannot show a confirmation dialog. " +
          "Nothing was sent or changed. Create a draft instead and send it from your mail program.",
      };
    }
    return { status: "client-approval" };
  }

  return {
    status: "pending",
    result: inputRequired({
      inputRequests: {
        [CONFIRM_KEY]: inputRequired.elicit({ message: request.message, requestedSchema: ConfirmSchema }),
      },
      requestState: mintConfirmationState(request.digest),
    }),
  };
}
