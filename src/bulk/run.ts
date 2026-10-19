import type { ImapFlow } from "imapflow";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import type { BulkAction as PolicyBulkAction } from "../policy/engine.js";
import type { AppConfig } from "../config/schema.js";
import type { ToolInvocation } from "../tools/shared/define-tool.js";
import type { FolderInfo } from "../imap/folders.js";
import { existingUids } from "../imap/strict.js";
import { selectByFilter } from "../imap/select.js";
import { envelopeDate } from "../imap/envelope.js";
import { summarizeSenders } from "../imap/senders.js";
import { highestRisk } from "../policy/observer.js";
import { scanSubjectOnly, type InjectionScanResult } from "../security/injection-detector.js";
import type { SearchFilters } from "../imap/search-query.js";
import { jsonResult } from "../tools/shared/result.js";
import { SelectionError, SelectionStore, type BulkAction } from "./selection.js";

const SAMPLE_SIZE = 10;
const TOP_SENDERS = 10;

/** Which policy cap applies (policy.bulk.maxMessages, or the stricter maxDelete for deletes). */
export function policyBulkAction(action: BulkAction): PolicyBulkAction {
  if (action.type === "delete") return "delete";
  if (action.type === "move") return action.intoTrash ? "delete" : "move";
  if (action.type === "markRead" || action.type === "markUnread") return "mark";
  return "flag";
}

const stores = new WeakMap<AppConfig, SelectionStore>();

/**
 * One store per loaded configuration. Keyed by `app.config`, not by the context object: HTTP mode
 * (Plan 7) wraps the context per request, and a token issued in one request must redeem in the next.
 */
export function selectionStore(app: AppContext): SelectionStore {
  let store = stores.get(app.config);
  if (!store) {
    store = new SelectionStore();
    stores.set(app.config, store);
  }
  return store;
}

export interface PreviewRequest {
  /** Resolved folder path. */
  folder: string;
  /** The account's folders as already listed (for the message scope). */
  folders?: FolderInfo[];
  filters: SearchFilters;
  action: BulkAction;
  /** Extra checks with the folder selected, before a token is issued (e.g. keyword support). */
  validate?: (client: ImapFlow) => void | Promise<void>;
}

export interface CommitRequest {
  token: string;
  folder: string;
  /** The account's folders as already listed (for the message scope). */
  folders?: FolderInfo[];
  action: BulkAction;
  /** Performs the change on exactly the previewed UIDs; returns fields for the response. */
  apply: (client: ImapFlow, uids: number[]) => Promise<Record<string, unknown>>;
}

/**
 * Step 1: select, check limits, issue a token. Changes nothing on the server. The selection is
 * already without the messages the account's message scope hides, so the token binds only
 * messages the AI may see.
 */
export async function previewBulk(app: AppContext, inv: ToolInvocation, req: PreviewRequest): Promise<CallToolResult> {
  const client = await inv.account.getClient();
  const lock = await client.getMailboxLock(req.folder);
  try {
    await req.validate?.(client);
    const selection = await selectByFilter(client, req.filters, inv.account.policy.messageScope(req.folders));
    // A forgotten or dropped criterion must not turn into "the whole folder": that takes {"all": true}
    if (Object.keys(selection.applied).length === 0) {
      throw new Error(
        `The filter has no criterion. To select every email in "${req.folder}", pass the filter {"all": true}. ` +
          `Nothing was ${req.action.type === "delete" ? "deleted" : "changed"}.`,
      );
    }
    if (selection.attachmentScanLimited || selection.labelScanLimited) {
      const what = selection.attachmentScanLimited ? "check their attachments" : "check them against your administrator's folder policy";
      throw new Error(`Too many messages match to ${what} reliably. Nothing was changed. Narrow the filter (for example with since/before) and preview again.`);
    }
    const count = selection.uids.length;
    inv.record({ folder: req.folder, action: req.action.type, count, preview: true });
    if (count === 0) {
      return jsonResult({
        preview: true,
        folder: req.folder,
        operation: req.action,
        appliedFilters: selection.applied,
        count: 0,
        note: "No messages match. Nothing was changed.",
      });
    }
    inv.account.policy.checkBulk(count, policyBulkAction(req.action));

    const sample: Array<{ uid: number; date?: string; from: string; subject: string; _injectionScan?: InjectionScanResult }> = [];
    for await (const msg of client.fetch(selection.uids.slice(-SAMPLE_SIZE), { uid: true, envelope: true }, { uid: true })) {
      const subject = msg.envelope?.subject ?? "";
      const scan = subject ? scanSubjectOnly(subject) : undefined;
      sample.push({
        uid: msg.uid,
        date: envelopeDate(msg.envelope?.date),
        from: msg.envelope?.from?.[0]?.address ?? "",
        subject,
        ...(scan?.hasInjection ? { _injectionScan: scan } : {}),
      });
    }
    sample.sort((a, b) => b.uid - a.uid);
    // Over the whole selection (at most the bulk cap): a stray sender in a mixed filter shows up here
    const senders = await summarizeSenders(client, selection.uids, { groupBy: "address", limit: TOP_SENDERS });
    inv.record({
      injectionRisk: highestRisk([...sample, ...senders.senders].map((entry) => entry._injectionScan?.riskLevel)),
    });

    const { token, expiresAt } = selectionStore(app).issue({
      accountId: inv.account.id,
      folder: req.folder,
      uidValidity: client.mailbox ? String(client.mailbox.uidValidity) : "",
      uids: selection.uids,
      action: req.action,
    });
    return jsonResult({
      preview: true,
      folder: req.folder,
      operation: req.action,
      appliedFilters: selection.applied,
      count,
      ...(selection.applied.all ? { warning: `This selects every message in "${req.folder}".` } : {}),
      topSenders: senders.senders,
      ...(senders.otherSenders ? { otherSenders: senders.otherSenders } : {}),
      sample,
      confirmToken: token,
      expiresAt,
      next:
        "Nothing has been changed yet. Show the user the count, the senders and the sample. If they agree, call this tool again with the same folder and action plus confirmToken to apply it to exactly these messages.",
    });
  } finally {
    try { lock.release(); } catch { /* connection may already be dead */ }
  }
}

/**
 * Step 2: apply to exactly the previewed messages, or refuse if anything changed — including a
 * previewed message that has since got a label the policy hides: it counts as gone.
 */
export async function commitBulk(app: AppContext, inv: ToolInvocation, req: CommitRequest): Promise<CallToolResult> {
  const selection = selectionStore(app).consume(req.token, {
    accountId: inv.account.id,
    folder: req.folder,
    action: req.action,
  });
  inv.account.policy.checkBulk(selection.uids.length, policyBulkAction(req.action));
  const client = await inv.account.getClient();
  const lock = await client.getMailboxLock(req.folder);
  try {
    const uidValidity = client.mailbox ? String(client.mailbox.uidValidity) : "";
    if (uidValidity !== selection.uidValidity) {
      throw new SelectionError(`The folder "${req.folder}" was reset on the server since the preview. Nothing was changed. Run the preview again.`);
    }
    const present = await existingUids(client, selection.uids, inv.account.policy.messageScope(req.folders));
    if (present.length !== selection.uids.length) {
      throw new SelectionError(
        `${selection.uids.length - present.length} of the ${selection.uids.length} previewed messages are no longer in "${req.folder}" (moved or deleted elsewhere). Nothing was changed. Run the preview again.`,
      );
    }
    const result = await req.apply(client, selection.uids);
    inv.record({
      folder: req.folder,
      action: req.action.type,
      count: selection.uids.length,
      uids: selection.uids,
      ...(req.action.type === "move" ? { destination: req.action.destination } : {}),
    });
    return jsonResult({ success: true, folder: req.folder, operation: req.action, count: selection.uids.length, ...result });
  } finally {
    try { lock.release(); } catch { /* connection may already be dead */ }
  }
}
