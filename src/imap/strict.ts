/**
 * Fail-closed wrappers around imapflow.
 *
 * imapflow reports many server refusals by resolving to `false` instead of throwing
 * (search, messageMove, messageCopy, messageFlagsAdd/Remove, messageDelete, status).
 * Every tool must go through these helpers so a refusal becomes an error the AI sees,
 * never a silent "success" or a silently widened result set.
 */
import type { ImapFlow, MailboxObject, SearchObject } from "imapflow";

export class ImapOperationError extends Error {
  constructor(message: string, readonly operation: string) {
    super(message);
    this.name = "ImapOperationError";
  }
}

export class MessageNotFoundError extends Error {
  constructor(readonly uid: number, readonly folder: string) {
    super(`No message with UID ${uid} exists in "${folder}". It may have been moved or deleted; search again to get current UIDs.`);
    this.name = "MessageNotFoundError";
  }
}

/** Whether a message with these Gmail labels is hidden. */
export type LabelCheck = (labels: ReadonlySet<string>) => boolean;

/**
 * Which messages of the selected mailbox the AI may see, beyond the folder rules that decide
 * whether the folder may be selected at all. On Gmail one message carries several labels, each
 * shown as a folder: a message with a label the policy hides stays hidden in every folder it
 * shows up in (src/policy/label-lock.ts). Every path that lists, reads or changes messages takes
 * a scope, so a hidden message behaves like one that does not exist.
 */
export interface MessageScope {
  /**
   * The check for one message's labels, or null when no message of this mailbox can be hidden
   * by a label. Null costs no IMAP command: other servers, and Gmail accounts without deny
   * rules, pay nothing.
   */
  labelCheck(client: ImapFlow): Promise<LabelCheck | null>;
}

/** Hides nothing: for callers outside any account policy. */
export const UNSCOPED: MessageScope = { labelCheck: async () => null };

/**
 * The labels of a message could not be read, so it is unknown whether the policy hides it. The
 * message never quotes the server's answer (it could name labels); the failure is kept as `cause`.
 */
export class LabelCheckError extends ImapOperationError {
  constructor(cause?: unknown) {
    super(
      "The mail server did not report the Gmail labels of every message, so it cannot be checked which messages this mailbox's folder locks hide. " +
        "Nothing was changed. Try again; if this keeps happening, check the connection to the mail server.",
      "labels",
    );
    this.name = "LabelCheckError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** UIDs per label FETCH: keeps each command line and answer small. */
const LABEL_FETCH_CHUNK = 1000;

function uidSet(uids: number[]): string {
  return uids.join(",");
}

/**
 * `uids` of the selected mailbox without the ones `check` hides, in the given order. Fails
 * closed: when the server does not report the labels of every one of them, nothing is returned.
 * Rows without labels are skipped (servers also send unsolicited FETCH rows, e.g. flag changes),
 * but every UID needs one row with labels.
 */
export async function withoutHiddenLabels(client: ImapFlow, uids: number[], check: LabelCheck): Promise<number[]> {
  const wanted = new Set(uids);
  const reported = new Set<number>();
  const hidden = new Set<number>();
  for (let i = 0; i < uids.length; i += LABEL_FETCH_CHUNK) {
    try {
      for await (const msg of client.fetch(uids.slice(i, i + LABEL_FETCH_CHUNK), { uid: true, labels: true }, { uid: true })) {
        if (!msg.labels || !wanted.has(msg.uid)) continue;
        reported.add(msg.uid);
        if (check(msg.labels)) hidden.add(msg.uid);
      }
    } catch (err) {
      throw new LabelCheckError(err);
    }
  }
  if (reported.size < wanted.size) throw new LabelCheckError();
  return uids.filter((u) => !hidden.has(u));
}

/** `uids` of the selected mailbox without the messages `scope` hides. No IMAP command when nothing can be hidden. */
export async function visibleUids(client: ImapFlow, uids: number[], scope: MessageScope): Promise<number[]> {
  if (uids.length === 0) return uids;
  const check = await scope.labelCheck(client);
  return check ? withoutHiddenLabels(client, uids, check) : uids;
}

export async function strictSearch(client: ImapFlow, query: SearchObject): Promise<number[]> {
  const result = await client.search(query, { uid: true });
  if (!Array.isArray(result)) {
    throw new ImapOperationError(
      "The mail server rejected the search. No messages were matched and nothing was changed.",
      "search",
    );
  }
  return result;
}

/** STATUS for a folder; imapflow resolves to false when the server refuses. */
export async function strictStatus(
  client: ImapFlow,
  path: string,
  query: { messages?: boolean; unseen?: boolean; uidNext?: boolean; uidValidity?: boolean },
) {
  const result = await client.status(path, query);
  if (!result) {
    throw new ImapOperationError(`The mail server refused to report the status of "${path}".`, "status");
  }
  return result;
}

/**
 * Which of `uids` currently exist in the selected mailbox and are not hidden by `scope`: a hidden
 * message is reported as missing, exactly like one that does not exist.
 */
export async function existingUids(client: ImapFlow, uids: number[], scope: MessageScope): Promise<number[]> {
  if (uids.length === 0) return [];
  return visibleUids(client, await strictSearch(client, { uid: uidSet(uids) }), scope);
}

/**
 * Move `uids` to `destination`. Without the MOVE extension imapflow falls back to
 * COPY + messageDelete, which without UIDPLUS is a plain EXPUNGE that erases every
 * other \Deleted message in the folder. We emulate the move ourselves in that case.
 */
export async function strictMove(client: ImapFlow, uids: number[], destination: string): Promise<Map<number, number>> {
  if (!client.capabilities.has("MOVE")) return copyThenExpunge(client, uids, destination);
  const result = await client.messageMove(uidSet(uids), destination, { uid: true });
  if (!result) {
    throw new ImapOperationError(
      `The mail server refused to move the messages to "${destination}". Nothing was moved.`,
      "move",
    );
  }
  return result.uidMap ?? new Map();
}

async function copyThenExpunge(client: ImapFlow, uids: number[], destination: string): Promise<Map<number, number>> {
  await assertExpungeScoped(client, uids, "Nothing was moved.");
  const copied = await client.messageCopy(uidSet(uids), destination, { uid: true });
  if (!copied) {
    throw new ImapOperationError(
      `The mail server refused to copy the messages to "${destination}". Nothing was moved.`,
      "move",
    );
  }
  try {
    await safeExpunge(client, uids);
  } catch (err) {
    const reason = err instanceof Error ? ` ${err.message}` : "";
    throw new ImapOperationError(
      `The messages were copied to "${destination}" but could not be removed from the source folder, so they now exist in both folders.${reason}`,
      "move",
    );
  }
  return copied.uidMap ?? new Map();
}

/** Without UIDPLUS, EXPUNGE removes every \Deleted message; refuse if that is more than `uids`. */
async function assertExpungeScoped(client: ImapFlow, uids: number[], nothingChanged: string): Promise<void> {
  if (client.capabilities.has("UIDPLUS")) return;
  const target = new Set(uids);
  const others = (await strictSearch(client, { deleted: true })).filter((u) => !target.has(u));
  if (others.length > 0) {
    throw new ImapOperationError(
      `This server does not support UIDPLUS, so removing the messages would also erase ${others.length} other message(s) already marked as deleted in this folder. ${nothingChanged}`,
      "expunge",
    );
  }
}

export async function strictStoreFlags(
  client: ImapFlow,
  uids: number[],
  flags: string[],
  action: "add" | "remove",
): Promise<void> {
  const ok =
    action === "add"
      ? await client.messageFlagsAdd(uidSet(uids), flags, { uid: true })
      : await client.messageFlagsRemove(uidSet(uids), flags, { uid: true });
  if (!ok) {
    throw new ImapOperationError(
      `The mail server refused to ${action} the flags ${flags.join(", ")}. Nothing was changed.`,
      "store",
    );
  }
}

/** Flags the selected mailbox cannot store permanently (imapflow would drop them silently). */
export function unsupportedFlags(mailbox: MailboxObject | false, flags: string[]): string[] {
  const permanent = mailbox ? mailbox.permanentFlags : undefined;
  if (!permanent || permanent.has("\\*")) return [];
  return flags.filter((f) => !permanent.has(f));
}

export async function strictAppend(
  client: ImapFlow,
  path: string,
  raw: Buffer,
  flags: string[],
): Promise<{ uid?: number }> {
  const result = await client.append(path, raw, flags);
  if (!result) {
    throw new ImapOperationError(`The mail server refused to store the message in "${path}".`, "append");
  }
  return { uid: result.uid };
}

/**
 * Permanently remove exactly `uids` from the selected mailbox.
 * Without UIDPLUS, EXPUNGE would also erase every other message already flagged \Deleted,
 * so we refuse in that case instead of deleting more than asked.
 */
export async function safeExpunge(client: ImapFlow, uids: number[]): Promise<void> {
  await assertExpungeScoped(client, uids, "Nothing was deleted.");
  const ok = await client.messageDelete(uidSet(uids), { uid: true });
  if (!ok) {
    throw new ImapOperationError("The mail server refused to delete the messages. Nothing was deleted.", "expunge");
  }
}

/**
 * Run a folder RENAME or DELETE (`op`) without an implicit expunge. imapflow deselects the folder
 * first when it is selected, with CLOSE on servers without UNSELECT, and CLOSE permanently removes
 * every message flagged \Deleted, also those another mail program flagged. While this holds a
 * read-only lock on INBOX, the folder is not selected and no other call can select it: EXAMINE
 * deselects without expunging (RFC 3501 6.4.2), and CLOSE removes nothing from a read-only INBOX.
 */
export async function withoutImplicitExpunge<T>(client: ImapFlow, op: () => Promise<T>): Promise<T> {
  if (client.capabilities.has("UNSELECT")) return op();
  const lock = await client.getMailboxLock("INBOX", { readOnly: true });
  try {
    return await op();
  } finally {
    try { lock.release(); } catch { /* connection may already be dead */ }
  }
}

/**
 * Download the full source of one message from the selected mailbox. A message `scope` hides is
 * not found, the same as a UID that does not exist; its labels and source come in one FETCH, so
 * there is no moment between checking and reading.
 */
export async function downloadMessage(client: ImapFlow, uid: number, folder: string, scope: MessageScope): Promise<Buffer> {
  const check = await scope.labelCheck(client);
  if (check) {
    let msg;
    try {
      msg = await client.fetchOne(String(uid), { uid: true, labels: true, source: true }, { uid: true });
    } catch (err) {
      throw new LabelCheckError(err);
    }
    if (!msg || msg.uid !== uid) throw new MessageNotFoundError(uid, folder);
    if (!msg.labels) throw new LabelCheckError();
    if (check(msg.labels) || !msg.source) throw new MessageNotFoundError(uid, folder);
    return msg.source;
  }
  const result = await client.download(String(uid), undefined, { uid: true });
  if (!result?.content) throw new MessageNotFoundError(uid, folder);
  const chunks: Buffer[] = [];
  for await (const chunk of result.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
