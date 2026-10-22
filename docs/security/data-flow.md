# Data flow and data protection

## 1. Components

| Component | Runs where | Role |
|---|---|---|
| Claude client (Desktop, claude.ai, Claude Code) | User's device / Anthropic | Shows the conversation, asks the user to approve tool calls, sends the conversation to the model |
| LLM (Claude) | Anthropic | Decides which tool to call; receives tool results |
| imap-mcp server | User's device (stdio) — or a self-hosted container (HTTP mode, Plan 7) | Executes tool calls against the mailbox, enforces permissions and policy, writes the audit log |
| Mail server | Mail provider or own server | Stores the mailbox (IMAP), sends mail (SMTP) |

## 2. What flows where

| Operation | Data leaving the mail server | Data reaching the LLM |
|---|---|---|
| list / count folders | Folder names, counts | Folder names and counts (hidden folders excluded) |
| search | Envelope data, flags, size, preview snippet | Sender, recipients, subject, date, preview (visible text only), injection scan result |
| read | Full message (parsed locally) | Visible text (hidden elements and invisible characters removed; bounded length; cleaned HTML only on request), attachment names/sizes, injection scan |
| download attachment | Attachment | Text attachments as visible text (HTML attachments converted); images as image content; other files only as file name (saved to the download folder instead of the conversation) |
| draft / reply / forward | Original message (for quoting) | The draft summary returned by the tool |
| send | — (draft or composed message goes **to** the mail server) | Delivery result, Message-ID |
| organise (move / flag / delete) | UIDs, folder names | Result counts |

The server itself sends nothing anywhere except to the configured IMAP/SMTP servers and — during setup or token refresh — to the OAuth endpoints of Microsoft or Google. Autoconfiguration lookups, which reveal the email domain, happen during setup and, in env-only mode without server fields, at every start (DNS MX, `autoconfig.<domain>`, `autoconfig.thunderbird.net`); disable them with `IMAP_MCP_NO_AUTOCONFIG=1`. There is **no telemetry**.

## 3. What is stored locally

| Item | Location | Protection | Contains message content? |
|---|---|---|---|
| Configuration | `~/.imap-mcp/config.json` | File mode 0600 | No |
| Passwords, OAuth refresh tokens | OS keychain (macOS Keychain, Windows Credential Manager, Secret Service) or Claude Desktop's encrypted extension settings | OS protection | No |
| Audit log | `~/.imap-mcp/audit/audit-YYYY-MM.jsonl` (configurable) | Mode 0600, hash chain | No (metadata only; subjects only at level `standard`) |
| Recipient provenance | Server process memory only, 24 hours, never on disk | Keyed hashes (HMAC-SHA256, random key per process) | No (hashes of addresses and domains that appeared in mail Claude read) |
| Send counters | `~/.imap-mcp/state/send-counter-<account>.json` | Mode 0600 | No (timestamps only) |
| Downloaded attachments | The configured download folder (Plan 3) | User's file permissions | Yes — only files the user asked to save |
| Logs | stderr (captured by the client) and optional `LOG_FILE` | — | No (secrets redacted, subjects/bodies omitted) |

## 4. Data protection (GDPR / DSGVO) notes

- **Controller:** the company using the server. **Processors:** the mail provider and the LLM provider. Use a commercial Claude plan (Team, Enterprise or API) and check that a data processing agreement (DPA) is in place; review the provider's current terms on data retention and model training.
- **Data minimisation:** keep the read tier on but restrict folders (`policy.folders`), keep `read_email` text limits low, prefer previews to full reads, keep the audit level `minimal` if subjects are sensitive.
- **Purpose limitation:** one account per purpose (e.g. `office@`), not the CEO's personal mailbox.
- **Retention:** audit files are deleted after `audit.retentionDays` (default 365). Downloaded attachments follow the company's normal file retention.
- **Data subject requests:** the server holds no mailbox copy; requests are handled in the mailbox itself. Audit records contain email addresses at level `standard`; use level `minimal` to store only domains.
- **Records of processing (Art. 30):** describe the server as "AI assistant access to mailbox X for purposes Y", processors as above, data categories as in section 2.

## 5. Removing all local data

1. Remove the extension/server from the Claude client.
2. Delete the folder `~/.imap-mcp` (configuration, audit log, counters) after archiving the audit log if your retention rules require it.
3. Remove the keychain entries named after the server (service `imap-mcp`), or revoke the app password / OAuth grant at the mail provider.
