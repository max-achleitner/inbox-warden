# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (see the [support policy](docs/support-policy.md)).

## [Unreleased]

### Security
- Attaching a local file checks the opened file again: if a folder on the path was swapped for a link to somewhere outside `files.attachmentDirs` after the path check, the attachment is refused instead of sending the other file. Linux compares the path the kernel reports for the open file; macOS and Windows compare the resolved path and the file identity (see the threat model for the remaining race).
- A file that grows or shrinks after its size was checked against the 25 MB limit is refused instead of being read whole.
- Folder rules now also hide Gmail's All Mail, Starred and Important (any folder the server lists as `\All`, `\Flagged` or `\Important`) as soon as they hide any folder. Before, `search_emails` and `read_email` could read the mail of a denied label through All Mail.
- `search_emails`, `read_email` and `get_thread` scan the display names of From, Reply-To, To and Cc for prompt injection (`location: "address_name"`). A manipulative sender name passed unscanned and never raised the send confirmation.
- Attachment paths are checked against `files.attachmentDirs` by their text before the file system is touched. On Windows, resolving a UNC path such as `\\host\share\x.pdf` alone sent the user's NTLM credentials to that host, even though the attachment was refused afterwards.
- `save_attachment` also refuses `.ppsm`, `.xlsb`, `.chm`, `.xll`, `.msc`, `.appxbundle`, `.msixbundle` and `.appinstaller`, and on Windows marks every saved file as downloaded from the internet (`Zone.Identifier`, Mark of the Web), so Office blocks macros in older formats such as `.doc` and SmartScreen applies.
- `audit verify` no longer accepts recent records removed from the start of the log behind a forged retention record. Each new record hashes the time of its predecessor (`prevTs`), and the oldest remaining record must prove that the removed ones were older than `audit.retentionDays`; the command prints the period it applied.
- `send_draft` refuses a draft with more than one sender (two `From` headers, or several addresses in one). The check read the last `From`, while many mail programs show the first.
- Previews of `organize_by_filter` and `delete_email` scan the sample subjects for prompt injection (`_injectionScan`), and a finding there or in a sender name raises the one-hour send confirmation like any other read.

### Added
- Filter `{"all": true}` selects every email in a folder; it cannot be combined with other filters.

### Changed
- `organize_by_filter` and `delete_email` refuse a filter without any criterion (`{}`, or an empty `header`) instead of previewing the whole folder; the whole folder takes `{"all": true}`.
- Upgrading a 0.1/0.2 configuration (`credentials.json`) switches sending and deleting off for the migrated mailbox; reading and organising stay as they were. Turn them on again with `inbox-warden accounts edit main --allow send` or `--allow delete`.
- `inbox-warden setup` lists every mailbox with what Claude may do there and marks the default mailbox, and asks whether a newly added mailbox becomes the default.
- An empty `policy.folders.allow` list stops the server with an error instead of allowing every folder; leave the key out to allow every folder.

## [0.6.0] - 2026-10-18

### Added
- Claude Desktop extension (`.mcpb`), signed, with a setup form and safe defaults.
- Claude Code plugin with inbox-triage, reply-drafting and mailbox-clean-up skills.
- Single `inbox-warden` command with `serve`, `setup`, `doctor`, `accounts`, `audit`.
- Release pipeline with npm provenance, SBOM, checksums and build attestations.
- User guides in German and English; privacy notice.
- Remote mode: `inbox-warden serve --http` (Streamable HTTP, stateless, SDK v2) with mandatory authentication — hashed bearer tokens or OAuth access tokens from your IdP (Entra ID, Keycloak), RFC 9728 protected resource metadata, per-caller mailbox mapping (`httpAuth.principals`). Tools that act on the server machine (`sign_in`) are not offered remotely; mailboxes are signed in with `inbox-warden accounts login <id> --no-browser`.
- `inbox-warden http token create|list|revoke`.
- Hardening: Host/Origin validation, optional IP allowlist, proxy-aware client IP, rate limits, body limit, security headers; every call is audited with the caller's identity.
- Docker image (distroless, non-root, read-only) and Caddy compose stack; container secret store with Docker secrets and an encrypted state file.
- Docs: `docs/deploy/http.md`, `docs/security/remote-mode.md`.
- `summarize_senders` (read): counts the emails of a folder per sender address or domain, with oldest and newest date; reads only envelopes.
- Bulk previews of `organize_by_filter` and `delete_email` list the senders of the whole selection (`topSenders`), so a stray match stands out before anything is changed.
- `gmailQuery` search filter for Gmail and Google Workspace accounts (Gmail search syntax via X-GM-RAW).
- `search_emails` `compact: true` leaves out Message-ID, recipients and size.
- `inbox-warden accounts edit <id>` changes permissions, the default mailbox, bulk limits (`--max-messages`, `--max-delete`) and the password without the wizard.

### Changed
- Unknown tool parameters and filter keys are rejected instead of being dropped. A dropped filter widened the selection, up to the whole folder.
- Moves of more than 50 emails report the count instead of every old→new UID pair (`uidMappingOmitted`).
- `health_check`: `smtp.configured` now only says whether an SMTP server is set up; the new `smtp.sendAllowed` says whether sending is permitted.
- The bulk-limit denial no longer suggests narrowing the selection by date (which amounts to splitting the change); it names `accounts edit` for raising the limit.
- Package renamed from `imap-mcp-server` to `inbox-warden`.
- Microsoft 365 and Outlook.com sign-in is a preview: no Microsoft client ID ships with Inbox Warden, so an administrator registers the app once (see `docs/guide/providers.md`); not yet tested against a real Microsoft 365 tenant.
- Moving emails into Trash with `move_email` or `organize_by_filter` now needs the delete permission and counts against `bulk.maxDelete`, like `delete_email`. The same applies to moving a folder into Trash with `rename_folder` (all its messages, subfolders included, count).
- `policy.attachments.blockExecutables` is the single check for executable and macro file types when saving attachments, with one combined list; setting it to `false` now really allows saving them.
- Refresh tokens: a token stored in the keychain (rotated or from a new sign-in) wins over `IMAP_MCP_OAUTH_REFRESH_TOKEN_<ID>`, as the encrypted state file already did in containers.
- Search filters: empty `header` names or values are rejected.
- `serve --http` warns when `files.downloadDir` lies inside `files.attachmentDirs` and several mailboxes are configured.
- OAuth remote mode: `email` principal rules only match verified addresses (`email` with `email_verified`/`xms_edov`, or Entra `upn` of members); `preferred_username` is no longer used.

### Fixed
- Newsletter preheader padding (`&#847;&zwnj;&nbsp;` runs) no longer counts as hidden text in the injection scan, and previews and `read_email` text drop it.
- `health_check` no longer reports a negative IMAP uptime when the check itself opens the connection.
- An unknown confirmation token explains that tokens are lost when the server restarts.
- Moves on servers without MOVE/UIDPLUS no longer erase other messages already marked as deleted.
- Attachments named like `invoice.exe.` are blocked like `invoice.exe`.
- Certificates issued by a private CA can be pinned.
- Send rate limits hold under parallel sends and across server processes; a failed counter update can no longer turn a sent email into an error, and failed deliveries do not use up the limit.
- In confirm mode over stateless HTTP, 2025-era clients are refused instead of sending without confirmation.
- `rename_folder` cannot move subfolders hidden by policy out of their deny rule; `get_quota` applies the folder policy.
- `sign_in` recovers after the token could not be stored.
- Missing or revoked credentials and certificate problems are no longer retried five times.
- A v1 configuration is only rewritten once its password is safely in the secret store.
- `audit verify` reports deleted oldest records unless a retention record explains them.
- macOS keychain without the native module: passwords with umlauts are read correctly.
- `create_folder` and `rename_folder` check the folder policy on the path the server really uses (including a namespace prefix such as `INBOX.`).
- A folder name that matches a folder hidden by policy is refused instead of being mapped to a visible folder with the same leaf name.
- `send_draft` only marks the original as answered in folders the policy lets the AI see.
- The "never emailed before" check compares exact addresses: `john@acme.co` no longer counts as known because `john@acme.com` is in Sent.
- A confirmation can only be used once; a retried request cannot send the same email again.
- `forward_draft` in attachment mode drops the `Bcc` header from the attached original.
- `search_emails` and bulk previews no longer fail on a message with an unparseable `Date` header.
- `hasAttachment` counts files sent as `inline` with a file name (Apple Mail, mobile clients); images embedded in HTML still do not count.
- Folders named `Deleted` are recognised as Trash again on servers without SPECIAL-USE.
- Keywords with non-ASCII characters are rejected instead of being silently dropped by the server library.
- Remote mode: an empty or padded `account` argument means the default mailbox, as it does locally.
- The audit log keeps working after a record was cut off by a crash; the damaged line stays visible to `audit verify` and a recovery record continues the chain.
- OAuth: when a rotated refresh token cannot be stored, the new access token is still used and the newest refresh token is kept in memory.
- Containers: an unreadable `secrets.enc.json` (changed `IMAP_MCP_STATE_KEY`, damaged file) no longer breaks accounts whose secrets come from environment variables, and the error names the state key.
- Remote OAuth mode: an unreachable or slow key server (JWKS) is reported as temporarily unavailable (503) instead of rejecting valid tokens.
- `http token create`/`revoke` refuse to save while `IMAP_MCP_EMAIL` selects the environment-only configuration (they used to overwrite `config.json`); `revoke` now says a restart is needed.
- File attachments are size-checked and read through one file handle, so a file swapped after the check is not attached; a named pipe in an attachment folder is refused instead of blocking.

### Deprecated
- Start commands `imap-mcp-server`, `imap-mcp-setup` and `node dist/index.js` — removed in 2.0.

## [0.6.0]

### Added
- Policy engine, confirmation for sending, rate limits, folder scope, tamper-evident audit log, security documentation (Plan 5).

## [0.5.0]

### Added
- OAuth2 sign-in for Microsoft 365 and Google Workspace (CLI and in-chat `sign_in`), OS keychain via `@napi-rs/keyring` with a fallback that needs no native modules, provider detection, certificate pinning, new `setup` and `doctor` (Plan 4).

## [0.4.0]

### Added
- Search previews, bounded `read_email`, bulk actions with preview and confirmation, `get_thread`, `forward_draft`, attachments from and to allowed folders (Plan 3).

## [0.3.0]

### Changed
- MCP SDK v2, several mailboxes per installation, sender names, signatures and aliases (Plan 2).

## [0.2.0]

### Fixed
- Search no longer falls back to all mail; server refusals are reported as errors; Sent copies; Reply-To and quoting; RFC 2231 attachment names; valid Message-IDs; mandatory STARTTLS (Plan 1).
