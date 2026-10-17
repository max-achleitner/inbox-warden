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

function uidSet(uids: number[]): string {
  return uids.join(",");
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

/** Which of `uids` currently exist in the selected mailbox. */
export async function existingUids(client: ImapFlow, uids: number[]): Promise<number[]> {
  if (uids.length === 0) return [];
  return strictSearch(client, { uid: uidSet(uids) });
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

/** Download the full source of one message from the selected mailbox. */
export async function downloadMessage(client: ImapFlow, uid: number, folder: string): Promise<Buffer> {
  const result = await client.download(String(uid), undefined, { uid: true });
  if (!result?.content) throw new MessageNotFoundError(uid, folder);
  const chunks: Buffer[] = [];
  for await (const chunk of result.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
