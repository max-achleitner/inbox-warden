# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An MCP (Model Context Protocol) server that exposes IMAP/SMTP email operations as tools for AI clients. Built with TypeScript (ES modules), uses `@modelcontextprotocol/sdk` for the MCP layer, `imapflow` for IMAP, `nodemailer` for SMTP, and `mailparser` for parsing emails.

## Commands

- **Build:** `npm run build` (runs `tsc`)
- **Dev:** `npm run dev` (runs `tsc --watch`)
- **Start:** `npm start` (runs `node dist/index.js`)
- **Setup:** `npm run setup` (interactive credential + permissions wizard)
- **Clean:** `npm run clean` (removes `dist/`)

No test framework is configured.

## Architecture

**Entry points:**
- `src/index.ts` — MCP server setup, permission-gated tool registration, stdio transport. IMAP client is lazy-initialized on first tool use; SMTP transport is only created when `send` permission is enabled.
- `src/setup.ts` — Interactive CLI for configuring credentials and permissions.

**Infrastructure modules:**
- `src/credentials.ts` — Loads/saves credentials and permissions from `~/.imap-mcp/credentials.json` (file mode 0o600). Exports `Permissions` interface, `DEFAULT_PERMISSIONS`, and `getPermissions()`.
- `src/imap-client.ts` — Factory that creates an `ImapFlow` client from credentials. Auto-detects TLS on port 993.
- `src/smtp-client.ts` — Factory that creates a `nodemailer` transport. Auto-detects TLS on port 465.

**Permission system:** Tools are grouped into four tiers. Each tier can be enabled/disabled in `~/.imap-mcp/credentials.json` under the `permissions` key. Tools in disabled tiers are never registered with the MCP server.

| Tier | Default | Tools |
|------|---------|-------|
| `read` | on | list_folders, search_emails, read_email, get_email_count, download_attachment |
| `write` | on | mark_as_read, move_email, create_draft, reply_draft, create/delete/rename_folder |
| `send` | off | send_email |
| `delete` | off | delete_email |

**Tools (src/tools/):** Each file exports a `register()` function. All tools have MCP annotations (`readOnlyHint`, `destructiveHint`).

- `list-folders.ts` — `list_folders`: Lists all mailboxes via `client.listTree()`.
- `search-emails.ts` — `search_emails`: Searches by query/from/to/date range/unseen with pagination (offset + maxResults).
- `read-email.ts` — `read_email`: Downloads and parses a single email by UID.
- `get-email-count.ts` — `get_email_count`: Returns total/unread counts for one or all folders.
- `download-attachment.ts` — `download_attachment`: Downloads a specific attachment as base64.
- `mark-as-read.ts` — `mark_as_read`: Sets/removes `\Seen` flag.
- `move-email.ts` — `move_email`: Moves emails between folders.
- `create-draft.ts` — `create_draft`: Composes email and saves to Drafts via IMAP APPEND. Also exports `buildRfc822Message()` and `findDraftsFolder()` used by reply-draft.
- `reply-draft.ts` — `reply_draft`: Creates a threaded reply draft with `In-Reply-To`/`References` headers.
- `manage-folders.ts` — `create_folder`, `delete_folder`, `rename_folder`: Exports three separate register functions (`registerCreate`, `registerDelete`, `registerRename`).
- `send-email.ts` — `send_email`: Sends email via SMTP.
- `delete-email.ts` — `delete_email`: Moves to Trash (or expunges if already in Trash). Auto-detects Trash folder via `specialUse` flag.

**Key patterns:**
- All tool handlers return JSON content blocks (`{ type: "text", text: JSON.stringify(...) }`).
- IMAP operations that read mailboxes acquire a lock via `getMailboxLock()` and release in a `finally` block.
- Zod schemas define tool input validation.
- Logging goes to stderr (stdout is reserved for MCP stdio transport).
- Draft tools build RFC 822 messages manually (no nodemailer dependency) and use IMAP APPEND with `\Draft` flag.
- Folder discovery helpers (`findDraftsFolder`, Trash detection in delete) use `specialUse` flags first, then fall back to common folder names.
