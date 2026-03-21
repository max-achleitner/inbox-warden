# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An MCP (Model Context Protocol) server that exposes IMAP/SMTP email operations as tools for AI clients. Built with TypeScript (ES modules), uses `@modelcontextprotocol/sdk` for the MCP layer, `imapflow` for IMAP, `nodemailer` for SMTP, and `mailparser` for parsing emails. Includes a prompt injection detection layer that scans all email content before returning it to the AI consumer.

## Commands

- **Build:** `npm run build` (runs `tsc`)
- **Dev:** `npm run dev` (runs `tsc --watch`)
- **Start:** `npm start` (runs `node dist/index.js`)
- **Setup:** `npm run setup` (interactive credential + permissions wizard)
- **Test:** `npm test` (runs `vitest run`)
- **Test watch:** `npm run test:watch`
- **Clean:** `npm run clean` (removes `dist/`)

To run a single test file: `npx vitest run src/security/__tests__/injection-detector.test.ts`

## Architecture

**Entry points:**
- `src/index.ts` — MCP server setup, permission-gated tool registration, stdio transport. IMAP client is lazy-initialized on first tool use with a mutex to prevent concurrent connection races. SMTP transport is only created when `send` permission is enabled.
- `src/setup.ts` — Interactive CLI for configuring credentials and permissions.

**Infrastructure modules:**
- `src/credentials.ts` — Loads config from `~/.imap-mcp/config.json` (file mode 0o600) and password from OS keychain via `keytar`. Auto-migrates legacy `credentials.json` files. Falls back to `IMAP_PASSWORD` env var. Validates required fields at load time. Exports `Permissions` interface, `DEFAULT_PERMISSIONS`, `getPermissions()`, `saveCredentials()`.
- `src/imap-client.ts` — `ImapConnectionManager` class with auto-reconnect (exponential backoff, max 5 retries), keep-alive (NOOP every 5 min), and connection mutex. Exports `ConnectionStats` for health monitoring. Auto-detects TLS on port 993.
- `src/smtp-client.ts` — Factory that creates a `nodemailer` transport. Auto-detects TLS on port 465.
- `src/errors.ts` — `errorMessage()` helper that safely extracts error messages without leaking stack traces. `ImapConnectionError` class for connection failures.
- `src/logging/logger.ts` — Structured JSON logging to stderr (stdout reserved for MCP stdio transport).

**Permission system:** Tools are grouped into four tiers. Each tier can be enabled/disabled in `~/.imap-mcp/credentials.json` under the `permissions` key. Tools in disabled tiers are never registered with the MCP server.

| Tier | Default | Tools |
|------|---------|-------|
| `read` | on | list_folders, search_emails, read_email, get_email_count, download_attachment, get_quota |
| `write` | on | mark_as_read, move_email, flag_email, create_draft, reply_draft, create/delete/rename_folder |
| `send` | off | send_email, send_draft |
| `delete` | off | delete_email |

**Tools (src/tools/):** Each file exports a `register()` function. All tools have MCP annotations (`readOnlyHint`, `destructiveHint`).

- `list-folders.ts` — `list_folders`: Lists all mailboxes via `client.listTree()`. Skips synthetic root node.
- `search-emails.ts` — `search_emails`: Gmail/Outlook-style filters (query, subject, from, to, cc, date range, unread, flagged, answered, hasAttachment, size, header). Pagination via offset + maxResults. Returns `_injectionScan` per message when detected (subject-only lightweight scan).
- `read-email.ts` — `read_email`: Downloads and parses a single email by UID. Runs full injection scan (subject + body + html + attachment names) and includes `_injectionScan` in response.
- `get-email-count.ts` — `get_email_count`: Returns total/unread counts for one or all folders.
- `download-attachment.ts` — `download_attachment`: Downloads a specific attachment. Text files returned as UTF-8, binary as base64. Scans text content for injection.
- `get-quota.ts` — `get_quota`: Returns mailbox storage quota (usage, limit, percentage). Handles servers that don't support QUOTA or return no resource data gracefully.
- `mark-as-read.ts` — `mark_as_read`: Sets/removes `\Seen` flag. UIDs validated with `.min(1)`.
- `move-email.ts` — `move_email`: Moves emails between folders. Returns UID mapping for tracking across folders.
- `flag-email.ts` — `flag_email`: Adds/removes IMAP flags (standard: `\Seen`, `\Flagged`, `\Answered`, `\Deleted`, `\Draft`; also custom keywords).
- `create-draft.ts` — `create_draft`: Composes email and saves to Drafts via IMAP APPEND. All header values sanitized against CRLF injection. Non-ASCII subjects RFC 2047 encoded. Also exports `buildRfc822Message()`, `findDraftsFolder()`, `sanitizeHeaderValue()`.
- `reply-draft.ts` — `reply_draft`: Creates a threaded reply draft with `In-Reply-To`/`References` headers. Case-insensitive `Re:` prefix handling. Validates original sender exists.
- `manage-folders.ts` — `create_folder`, `delete_folder`, `rename_folder`: Three separate register functions. `delete_folder` checks message count and subfolders before allowing deletion.
- `send-email.ts` — `send_email`: Sends email via SMTP (nodemailer handles header safety).
- `send-draft.ts` — `send_draft`: Fetches a draft by UID from the Drafts folder, sends it via SMTP, then deletes the draft. Full create_draft → review → send_draft workflow.
- `delete-email.ts` — `delete_email`: Moves to Trash (or expunges if already in Trash). Case-insensitive Trash folder detection via `specialUse` flag then name fallback.
- `health-check.ts` — `health_check`: Returns server health status including IMAP connection state, SMTP config, security scan stats, and uptime. Always registered (not gated by permissions).

**Security layer (src/security/):**
- `patterns.ts` — All regex patterns and keyword lists organized by detection category. Pre-compiled at module load. Confidence scores per pattern. `computeRiskLevel()` for compound scoring (multiple low-confidence findings escalate).
- `unicode-normalizer.ts` — `normalizeToASCII()` converts trick Unicode to ASCII for detection only: Regional Indicators, Enclosed Supplement, Fullwidth, Mathematical Alphanumeric (bold/italic/script/fraktur/double-struck/monospace), Superscript/Subscript, Circled, Small Caps, NFKD + combining mark stripping. `hasNonAscii()` for fast-path bypass.
- `injection-detector.ts` — `scanForInjection(input)` and `scanSubjectOnly(subject)`. Runs 7 detection categories: direct instruction (EN/DE), unicode obfuscation, invisible text, HTML/comment injection, structured data injection, social engineering/authority claims, encoding evasion (base64/URL/hex). Early exit on critical. Multi-vector detection adds compound finding when 3+ techniques detected.

**Key patterns:**
- All tool handlers return JSON content blocks (`{ type: "text", text: JSON.stringify(...) }`).
- IMAP operations that read mailboxes acquire a lock via `getMailboxLock()` and release in a `finally` block.
- Zod schemas define tool input validation.
- Logging goes to stderr (stdout is reserved for MCP stdio transport).
- Draft tools build RFC 822 messages manually with `sanitizeHeaderValue()` on all headers and use IMAP APPEND with `\Draft` flag.
- Folder discovery helpers (`findDraftsFolder`, Trash detection) use `specialUse` flags first, then fall back to case-insensitive name matching.
- Error messages use `errorMessage()` helper to avoid leaking stack traces.
- Injection scan metadata (`_injectionScan`) is attached to responses — original email content is never modified.
