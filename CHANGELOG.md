# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (see the [support policy](docs/support-policy.md)).

## [Unreleased]

### Security
- `create_draft` and `reply_draft` remove remote images, external style sheets, scripts and similar remote content from the HTML Claude writes: a remote image can report when a draft is opened and carry data in its address. The result counts what was removed (`remoteContentRemoved`) and lists the link targets (`linkTargets`) for you to check. Your signature and the quoted original are not changed.
- Sending to a recipient that appears only inside a received email and was never written to always needs the confirmation dialog, also in `direct` mode, and the dialog says why; a client that cannot show the dialog cannot send it. `policy.untrustedRecipients: "refuse"` refuses the send.
- Search previews, subjects, sender names, bulk previews and sender summaries no longer contain invisible characters or hidden HTML text. `download_attachment` returns HTML attachments (AMP parts too) as visible text (`convertedFromHtml`) and strips invisible characters from text attachments.
- `read_email` and `get_thread` give Claude only the text a reader sees: elements hidden with inline styles or simple style rules (`display:none`, white on white, 1px fonts, off-screen, …), invisible characters and Unicode tag characters are removed, also from link targets and other HTML attributes, and `hiddenContentRemoved` says how much. The content of `iframe`, `noembed` and `noframes` elements, which a reader never sees, is removed too and only checked for prompt injection. Zero-width characters in a link target are shown percent-encoded, so a look-alike such as `pay%E2%80%8Bpal.com` stays visible. When the plain-text part and the visible HTML differ — the text part says more, or it is only a stub such as "View in browser" — Claude gets the HTML text (`textPartDiffers`); the plain-text part is still checked for prompt injection. `includeHtml` returns the cleaned HTML. The plain-text quote in reply drafts and inline forwards carries the visible text too. Message-IDs, `References` and `List-Unsubscribe` lose hidden tag characters; addresses are shown exactly as they are.
- `reply_draft`, `forward_draft`, `send_draft` and `save_attachment` return the original's subject, names and file names without invisible characters; the draft itself keeps them unchanged. `save_attachment` saves a file under its visible name.
- One crafted email could block the server for minutes: thousands of nested or stray tags made the HTML parser, and long runs of tags without spaces or deeply nested quotes made the conversion to text, take time that grew with the square of the input. HTML the parser would need long for, and any HTML part over 5 MB, is no longer parsed: Claude sees only the plain-text part of such an email (`htmlTooComplex`) and drafts with such HTML are refused; the conversion to text no longer wraps lines and marks nested quotes only once, and `get_thread` checks at most 10 MB of HTML per call.
- A crafted email could block the server for minutes: long runs of spaces or invisible characters made the prompt-injection scan take time that grew with the square of the input. The scan and the new hidden-text check now take linear time, also for long numbers in styles, thousands of style rules and unclosed CSS comments; inline styles over 16 KiB are not evaluated. Style sheets longer than 64 KiB are not evaluated; then only the `hidden` attribute hides text.
- At audit level `minimal`, error texts keep only the domain of an address (`…@example.com`), as the recipient fields already did. Before, a refusal or delivery error that named a recipient stored the full address.
- A damaged configuration file is no longer quoted in error messages; before, a fragment of it (possibly a password) could appear in the log.
- Attaching a local file checks the opened file again: if a folder on the path was swapped for a link to somewhere outside `files.attachmentDirs` after the path check, the attachment is refused instead of sending the other file. Linux compares the path the kernel reports for the open file; macOS and Windows compare the resolved path and the file identity (see the threat model for the remaining race).
- A file that grows or shrinks after its size was checked against the 25 MB limit is refused instead of being read whole.
- Folder rules now also hide Gmail's All Mail, Starred and Important (any folder the server lists as `\All`, `\Flagged` or `\Important`) as soon as they hide any folder. Before, `search_emails` and `read_email` could read the mail of a denied label through All Mail.
- `search_emails`, `read_email` and `get_thread` scan the display names of From, Reply-To, To and Cc for prompt injection (`location: "address_name"`). A manipulative sender name passed unscanned and never raised the send confirmation.
- Attachment paths are checked against `files.attachmentDirs` by their text before the file system is touched. On Windows, resolving a UNC path such as `\\host\share\x.pdf` alone sent the user's NTLM credentials to that host, even though the attachment was refused afterwards.
- `save_attachment` also refuses `.ppsm`, `.xlsb`, `.chm`, `.xll`, `.msc`, `.appxbundle`, `.msixbundle` and `.appinstaller`, and on Windows marks every saved file as downloaded from the internet (`Zone.Identifier`, Mark of the Web), so Office blocks macros in older formats such as `.doc` and SmartScreen applies.
- `audit verify` no longer accepts recent records removed from the start of the log behind a forged retention record. Each new record hashes the time of its predecessor (`prevTs`), and the oldest remaining record must prove that the removed ones were older than `audit.retentionDays`; the command prints the period it applied.
- Browser sign-in on Windows starts `rundll32.exe` by its full System32 path; a bare name is looked up in the working directory first.
- `send_draft` refuses a draft with more than one sender (two `From` headers, or several addresses in one). The check read the last `From`, while many mail programs show the first.
- Previews of `organize_by_filter` and `delete_email` scan the sample subjects for prompt injection (`_injectionScan`), and a finding there or in a sender name raises the one-hour send confirmation like any other read.
- A locked folder (`policy.folders.deny`) takes every folder below it along, a folder name is locked wherever it is, and the `INBOX.` prefix some servers (Dovecot, Courier, Cyrus) put before every folder no longer matters. Before, `"deny": ["_NDA_Inbox"]` left `_NDA_Inbox/Projekt`, `INBOX._NDA_Inbox` and `Projekte/_NDA_Inbox` readable. A leading `/` limits a name to the top level (`/Archiv`); a pattern with a path (`Projekte/_NDA_Inbox`) still matches only that place.
- Renaming or deleting a folder could permanently erase mail: on servers without UNSELECT the IMAP library closed a selected folder with CLOSE first, which removes every message flagged as deleted, also messages another mail program flagged. Both now run without selecting the folder.
- `delete_folder` refuses when the server does not report how many messages the folder holds, instead of deleting it with whatever it contains.
- Gmail: a message that carries a locked label is hidden in every folder it shows up in (Inbox, Sent, other labels) and in every tool. It is not listed, counted, read, changed or replied to, and asking for its UID gets the same answer as a message that does not exist. Before, mail filed under a locked label stayed readable through any visible label it also carried. On such an account `get_email_count` counts by reading labels (up to 20,000 messages per call), and searches check the newest 20,000 matches.

### Added
- Drafts (`create_draft`, `reply_draft`, `forward_draft`) report `recipientWarnings` when a recipient appears only inside a received email that Claude read — in its text, a link, or a Reply-To on another domain — and the mailbox has never written to it. `policy.untrustedRecipients: "refuse"` refuses such drafts. The server keeps keyed hashes of the addresses it saw in memory for 24 hours; they never reach a log or the audit log.
- `reply_draft` says when the reply goes to a Reply-To address on another domain than the sender (`replyToNote`) — a common trick in invoice fraud.
- The extension has an icon (envelope with a shield).
- Filter `{"all": true}` selects every email in a folder; it cannot be combined with other filters.
- Folder locks for the Claude Desktop extension and the Claude Code plugin: the setting "Folders Claude must not see" (`IMAP_MCP_DENY_FOLDERS`, comma-separated, wildcards such as `_NDA_*`). Before, only a hand-edited `config.json` could lock folders.
- `inbox-warden accounts edit <id> --lock-folder <name>` and `--unlock-folder <name>`. `accounts list` and `setup` show the locked folders of each mailbox.
- `inbox-warden doctor` warns about a folder lock that matches no folder on the server, so a typo does not leave the real folder visible unnoticed.
- User guide: "Lock folders away from Claude", with server rules for Microsoft 365, Gmail and Sieve that file mail into a locked folder before it reaches the Inbox.

### Changed
- An injection finding no longer blocks sending in `confirm` mode for clients without a confirmation dialog; the dialog shows a warning instead. `direct` mode still needs a dialog after a finding. The default `confirmAfterInjectionRisk` is now `high` (was `medium`); set `medium` to keep the old threshold. Read calls enter the audit log for injection from `medium` on.
- The prompt-injection check reads what Claude reads (visible text, plus hidden text as `location: "hidden"`) instead of raw HTML, and is recalibrated: common phrases ("Role:", "System:", "vertraulich behandeln", "You are now subscribed") count as `low`, explicit instructions to an AI as `high`. Normal newsletters with dark-mode logos or white button text no longer scan `medium`. Flag emoji, other emoji and the fullwidth punctuation of Japanese and Chinese text no longer count as Unicode tricks, and the same finding in subject, body and sender name counts once. Below `high`, the scan's `sanitizedPreview` calls a finding a weak hint instead of a prompt-injection indicator.
- The install form of the extension and plugin is shorter and its titles explain themselves: email address and password, your name, two switches ("Claude may send email", "Claude may move email to Trash", both off), locked folders, attachment and download folders, and an "Advanced" group for servers, login name and the online server lookup. Microsoft 365 / Google Workspace sign-in is only available in the command-line version. Ports go into the server fields as `server:port`. The language of quote lines and forward headers in drafts follows the system. Sending always asks first.
- User guides describe the install as it really works (drag into Settings → Extensions, Configure, new chat).
- Upgrade note: after updating from 0.6, switch "Claude may send email" or "Claude may move email to Trash" on again if you had allowed it; Microsoft 365 and Google Workspace users of the extension move to the command-line version. If you had entered an IMAP or SMTP port, add it to the server field as `server:port` (for example `imap.example.com:143`).
- When the settings are incomplete or invalid, the extension still starts and Claude explains what to correct (command-line users are pointed to `inbox-warden setup` and `inbox-warden doctor`), instead of Claude Desktop only showing "Cannot connect to the extension server".
- Requires Node.js 20.19.0 or newer (was 20.18.0), as `html-to-text` 10 does; Node.js 20 reached end-of-life in April 2026. The Claude Desktop extension refuses older runtimes with a clear message. Claude Desktop itself ships Node.js 24.
- `organize_by_filter` and `delete_email` refuse a filter without any criterion (`{}`, or an empty `header`) instead of previewing the whole folder; the whole folder takes `{"all": true}`.
- Upgrading a 0.1/0.2 configuration (`credentials.json`) switches sending and deleting off for the migrated mailbox; reading and organising stay as they were. Turn them on again with `inbox-warden accounts edit main --allow send` or `--allow delete`.
- `inbox-warden setup` lists every mailbox with what Claude may do there and marks the default mailbox, and asks whether a newly added mailbox becomes the default.
- An empty `policy.folders.allow` list stops the server with an error instead of allowing every folder; leave the key out to allow every folder.
- Claude never deletes mail permanently. `delete_email` only moves mail into the Trash: it refuses emails that are already in the Trash or a folder below it, and accounts without a Trash folder. Emptying the Trash is done in your own mail program.
- `send_draft` removes the sent draft only when the Sent folder holds a copy of the email. Otherwise (`sentCopy: "never"`, or storing the copy failed) the draft goes to the Trash instead of being erased; without a Trash folder it stays in Drafts.
- Existing deny patterns now hide more (subfolders, the same name at any depth), and folder-lock refusals say that nothing was changed.
- Refusals for locked folders, blocked recipient domains, bulk limits and blocked attachment types say that the mailbox's settings cause them, instead of naming an administrator.
- README: the security section starts with what Claude is allowed to do; prompt-injection screening is described as an extra signal, not a guarantee. "Verify downloads" leads with the build attestation, and the checksum check works when only some files were downloaded.

### Fixed
- `read_email` no longer fails on HTML nested thousands of levels deep.
- `create_draft` no longer points to `send_draft` when no mailbox may send; that tool does not exist then.
- `health_check` counts every prompt-injection scan (`security.totalScans`, `totalDetections`), also those of search results, threads, attachments and previews. Before, only `read_email` counted. The counters are per process; `security.since` gives the start time.
- `search_emails` and `read_email` agree on what an attachment is. `read_email` now also gives `hasAttachment` and marks images embedded in the email (logos) with `embedded: true`; it still lists every part with its index. Before, `search_emails` said `hasAttachment: false` while `read_email` listed the logos as attachments.
- `search_emails` returns the newest mail first by date received (`sortedBy: "date"`) and pages over that order. Before, results came in UID order, which mixes up mail that was moved into a folder: it gets a new UID but keeps its date. Above 20,000 matches the UID order is kept (`sortedBy: "uid"` and a `note`).
- The Claude Desktop extension can be installed again: the signed 0.6.0 bundle was rejected by Claude Desktop ("Invalid comment length"). From 0.7.0 on the bundle is not signed; checksums and the build attestation prove its origin.
- With "don't look up servers online" switched on, Gmail, GMX, iCloud and the other built-in providers are still recognised; before, the extension did not start at all for them.

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
