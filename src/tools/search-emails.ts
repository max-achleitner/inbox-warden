import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";
import { scanSubjectOnly } from "../security/injection-detector.js";

/** Safely extract address from an envelope address object */
function parseEnvelopeAddress(a: any): { name: string; address: string } {
  return {
    name: a.name || "",
    address: a.address || (a.mailbox && a.host ? `${a.mailbox}@${a.host}` : ""),
  };
}

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "search_emails",
    "Search emails with filters similar to Gmail/Outlook. Combine any filters freely.",
    {
      folder: z.string().default("INBOX").describe("Mailbox folder path (e.g., INBOX, Sent, Drafts)"),

      // Text search
      query: z.string().optional().describe("Search text in subject and body"),
      subject: z.string().optional().describe("Search only in subject line"),

      // People
      from: z.string().optional().describe("Filter by sender email or name"),
      to: z.string().optional().describe("Filter by To: recipient"),
      cc: z.string().optional().describe("Filter by CC: recipient"),

      // Date range
      since: z.string().optional().describe("Emails after this date (YYYY-MM-DD)"),
      before: z.string().optional().describe("Emails before this date (YYYY-MM-DD)"),

      // Status flags
      unread: z.boolean().optional().describe("true = only unread, false = only read"),
      flagged: z.boolean().optional().describe("true = only starred/flagged, false = only unflagged"),
      answered: z.boolean().optional().describe("true = only replied-to, false = only unreplied"),

      // Attachments & size
      hasAttachment: z.boolean().optional().describe("true = only emails with attachments"),
      largerThan: z.number().optional().describe("Only emails larger than this size in bytes"),
      smallerThan: z.number().optional().describe("Only emails smaller than this size in bytes"),

      // Header search
      header: z.record(z.string()).optional().describe("Match specific headers, e.g. {\"X-Mailer\": \"outlook\"}"),

      // Pagination
      maxResults: z.number().min(1).max(50).default(20).describe("Maximum results to return"),
      offset: z.number().min(0).default(0).describe("Skip this many results (for pagination)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ folder, query, subject, from, to, cc, since, before, unread, flagged, answered, hasAttachment, largerThan, smallerThan, header, maxResults, offset }) => {
      try {
        const client = await getClient();
        let lock;
        try {
          lock = await client.getMailboxLock(folder);
        } catch (lockError) {
          return {
            content: [{ type: "text", text: `Error opening folder "${folder}": ${errorMessage(lockError)}` }],
            isError: true,
          };
        }

        try {
          const searchCriteria: any = {};

          // Text search
          if (query) searchCriteria.or = [{ subject: query }, { body: query }];
          if (subject) searchCriteria.subject = subject;

          // People
          if (from) searchCriteria.from = from;
          if (to) searchCriteria.to = to;
          if (cc) searchCriteria.cc = cc;

          // Date range
          if (since) searchCriteria.since = since;
          if (before) searchCriteria.before = before;

          // Status flags
          if (unread !== undefined) searchCriteria.seen = !unread;
          if (flagged !== undefined) searchCriteria.flagged = flagged;
          if (answered !== undefined) searchCriteria.answered = answered;

          // Size filters
          if (largerThan) searchCriteria.larger = largerThan;
          if (smallerThan) searchCriteria.smaller = smallerThan;

          // Header search
          if (header) searchCriteria.header = header;

          // Attachment filter — IMAP doesn't have a native "has attachment" search,
          // so we fetch bodyStructure and filter client-side after the initial search
          const hasSearch = Object.keys(searchCriteria).length > 0;
          let uids: number[];
          try {
            const result = hasSearch
              ? await client.search(searchCriteria, { uid: true })
              : await client.search({ all: true }, { uid: true });
            uids = Array.isArray(result) ? result : [];
          } catch (searchError) {
            // If a filtered search fails, try without filters
            if (hasSearch) {
              try {
                const fallback = await client.search({ all: true }, { uid: true });
                uids = Array.isArray(fallback) ? fallback : [];
              } catch {
                // Both searches failed — return the original error
                return {
                  content: [{ type: "text", text: `Error searching emails: ${errorMessage(searchError)}` }],
                  isError: true,
                };
              }
            } else {
              return {
                content: [{ type: "text", text: `Error searching emails: ${errorMessage(searchError)}` }],
                isError: true,
              };
            }
          }

          // Client-side attachment filtering if needed
          if (hasAttachment && uids.length > 0) {
            const filtered: number[] = [];
            // Fetch bodyStructure for all matched UIDs to filter accurately
            for await (const msg of client.fetch(uids, { uid: true, bodyStructure: true }, { uid: true })) {
              if (hasAttachmentPart(msg.bodyStructure)) {
                filtered.push(msg.uid);
              }
            }
            // Sort filtered UIDs numerically (IMAP UIDs are ascending by arrival)
            filtered.sort((a, b) => a - b);
            uids = filtered;
          }

          // Paginate: most recent first
          const totalMatches = uids.length;
          const sorted = uids.slice().reverse();
          const recentUids = sorted.slice(offset, offset + maxResults);

          if (recentUids.length === 0) {
            return {
              content: [{ type: "text", text: JSON.stringify({ count: 0, totalMatches, messages: [] }) }],
            };
          }

          const messages: any[] = [];
          for await (const msg of client.fetch(recentUids, {
            uid: true,
            envelope: true,
            flags: true,
            bodyStructure: true,
            size: true,
          }, { uid: true })) {
            const subject = msg.envelope?.subject;
            const _injectionScan = subject ? scanSubjectOnly(subject) : undefined;
            messages.push({
              uid: msg.uid,
              subject,
              from: msg.envelope?.from?.map(parseEnvelopeAddress),
              to: msg.envelope?.to?.map(parseEnvelopeAddress),
              date: msg.envelope?.date?.toISOString(),
              flags: Array.from(msg.flags || []),
              hasAttachment: hasAttachmentPart(msg.bodyStructure),
              size: msg.size,
              ...(_injectionScan?.hasInjection ? { _injectionScan } : {}),
            });
          }

          // Sort by UID descending (most recent first) since IMAP fetch order is unspecified
          messages.sort((a: any, b: any) => b.uid - a.uid);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({ count: messages.length, totalMatches, offset, messages }, null, 2),
            }],
          };
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error searching emails: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}

/** Check if a MIME body structure contains attachment parts */
function hasAttachmentPart(structure: any): boolean {
  if (!structure) return false;
  if (structure.disposition === "attachment") return true;
  if (structure.childNodes) {
    return structure.childNodes.some(hasAttachmentPart);
  }
  return false;
}
