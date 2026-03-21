import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { errorMessage } from "../errors.js";

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
        const lock = await client.getMailboxLock(folder);

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
          const result = hasSearch
            ? await client.search(searchCriteria, { uid: true })
            : await client.search({ all: true }, { uid: true });

          let uids = Array.isArray(result) ? result : [];

          // Client-side attachment filtering if needed
          if (hasAttachment && uids.length > 0) {
            const filtered: number[] = [];
            // Fetch bodyStructure for all matched UIDs to filter accurately
            for await (const msg of client.fetch(uids, { uid: true, bodyStructure: true })) {
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
          })) {
            messages.push({
              uid: msg.uid,
              subject: msg.envelope?.subject,
              from: msg.envelope?.from?.map((a: any) => ({
                name: a.name,
                address: `${a.mailbox}@${a.host}`,
              })),
              to: msg.envelope?.to?.map((a: any) => ({
                name: a.name,
                address: `${a.mailbox}@${a.host}`,
              })),
              date: msg.envelope?.date?.toISOString(),
              flags: Array.from(msg.flags || []),
              hasAttachment: hasAttachmentPart(msg.bodyStructure),
              size: msg.size,
            });
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({ count: messages.length, totalMatches, offset, messages }, null, 2),
            }],
          };
        } finally {
          lock.release();
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
