import type { ImapFlow } from "imapflow";
import { strictSearch, strictStoreFlags } from "../imap/strict.js";

export interface AnsweredOriginal {
  folder: string;
  uid: number;
}

/**
 * Best effort: set \Answered on the message a sent reply refers to, so "unanswered" filters
 * stay correct. Looks in `folders` in order; never throws.
 */
export async function markOriginalAnswered(
  client: ImapFlow,
  inReplyTo: string | undefined,
  folders: string[],
): Promise<AnsweredOriginal | false> {
  if (!inReplyTo) return false;
  for (const folder of [...new Set(folders)]) {
    let lock;
    try {
      lock = await client.getMailboxLock(folder);
    } catch {
      continue;
    }
    try {
      const [uid] = await strictSearch(client, { header: { "message-id": inReplyTo } });
      if (uid !== undefined) {
        await strictStoreFlags(client, [uid], ["\\Answered"], "add");
        return { folder, uid };
      }
    } catch {
      // best effort: the reply was sent; a missing \Answered flag is not worth an error
    } finally {
      try { lock.release(); } catch { /* connection may already be dead */ }
    }
  }
  return false;
}
