# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Inbox Warden (`inbox-warden`) is an MCP (Model Context Protocol) server that exposes IMAP/SMTP email operations for one or more mail accounts as tools for AI clients. Built with TypeScript (ES modules, Node ≥ 20.19), MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), zod 4, `imapflow` 2 for IMAP, `nodemailer` 10 for SMTP and message composition, and `mailparser` for parsing. A prompt injection detection layer scans email content before it is returned to the AI.

Production-readiness work is specified in `docs/superpowers/specs/2026-10-14-production-readiness-design.md` and executed through the plans in `docs/superpowers/plans/`.

## Commands

- **Build:** `npm run build` (runs `tsc`)
- **Dev:** `npm run dev` (runs `tsc --watch`)
- **Start:** `npm start` (runs `node dist/bin.js serve`)
- **CLI help:** `node dist/bin.js help` (`inbox-warden [serve | setup | doctor | accounts … | audit verify | help | version]`)
- **Setup:** `npm run setup` (guided: provider detection, hidden password, OAuth sign-in, connection test, certificate trust)
- **Doctor:** `npm run doctor` (non-interactive health report; exit code 1 on problems)
- **Sign in again (OAuth):** `node dist/bin.js accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]`
- **Edit an account:** `node dist/bin.js accounts edit <id> [--allow|--deny <read|write|send|delete>] [--default] [--max-messages <n>] [--max-delete <n>] [--lock-folder <pattern>]… [--unlock-folder <pattern>]… [--password]`
- **Test:** `npm test` (unit tests, no network)
- **Typecheck incl. tests:** `npm run typecheck`
- **Integration tests:** `docker compose -f test/docker-compose.greenmail.yml up -d` then `IMAP_IT_HOST=localhost npm run test:integration` (skipped when `IMAP_IT_HOST` is unset)
- **Test watch:** `npm run test:watch`
- **Clean:** `npm run clean` (removes `dist/`)
- **Remote server:** `node dist/bin.js serve --http` (refuses to start without `httpAuth`); tokens: `node dist/bin.js http token create --id <name>`
- **Docker:** `docker build -t inbox-warden:dev .`; stack in `deploy/docker-compose.yml`

To run a single test file: `npx vitest run src/tools/__tests__/search-emails.test.ts`

## Architecture

**Entry points:**
- `src/bin.ts` — the `inbox-warden` command: `src/cli/dispatch.ts` (`parseCommand`, `helpText`, `legacyInvocation`; no argument = `serve`) and `src/cli/program.ts` (`run`/`main`/`runLegacy`: `serve`, `help`, `version` itself; `setup`, `doctor`, `accounts …`, `audit …` go to `runCli`). Applies `applyBundleEnv` (MCPB/plugin environment) before every command.
- `src/serve.ts` — `serve(args)`: `loadConfig()` → `createAppContext()` → `serveStdio(() => createServer(app))`, graceful shutdown.
- `src/setup-problem.ts` — stdio `serve` only: when `applyBundleEnv`, endpoint detection, `loadConfig`, `createAppContext` or `setupAudit` fails, `serveSetupProblem(message, env)` (advice by environment: form setup `IMAP_MCP_EMAIL` without `IMAP_MCP_CONFIG` → Configure dialog / `/mcp` Reconnect, otherwise `inbox-warden setup`/`doctor`) starts a server with just `health_check` and `list_accounts` (both return the problem and the fix as an error, no mail access) instead of exiting; `serve --http` and admin commands still exit with code 1.
- `src/index.ts`, `src/cli/main.ts` — pre-1.0 shims (`imap-mcp-server`/`node dist/index.js` → serve, `imap-mcp-setup`/`node dist/cli/main.js` → setup or the named admin command), warn on stderr, removed in 2.0.
- `src/server.ts` — side-effect-free `createServer(app)`: `McpServer` with `SERVER_INSTRUCTIONS` (`src/instructions.ts`) and every tool from `ALL_TOOLS` (`src/tools/index.ts`).
- `runCli()` in `src/cli/run.ts`: `inbox-warden [setup | doctor | accounts list | accounts login <id> … | accounts edit <id> … | audit verify]`. Parsing in `args.ts` (pure), commands in `setup.ts`, `doctor.ts`, `login.ts`, `edit.ts` (dependency-injected, tested with fakes and a scripted prompter). The setup wizard only adds/removes accounts and signs in again; `accounts edit` changes permissions, default account, `policy.bulk` limits, locked folders (`policy.folders.deny`; `--unlock-folder` removes only an exact entry) and the password (validated with `ConfigSchema` before saving). `accounts list` and the wizard's overview show locked folders; `doctor` warns (exit code unchanged) about every deny pattern that matches none of the listed folders (`unmatchedDenyPatterns`, via `folderDenied`).

**Configuration and secrets:**
- `src/config/schema.ts` — zod schema for config v2: `accounts[]` with `id`, `email`, `imap`/`smtp` endpoints (optional certificate pin `tlsFingerprint256` + `tlsCertificatePem`), `auth` (password or OAuth2 Microsoft/Google), `identities` (display name, signature, aliases), `permissions`, `sentCopy`, `locale`, `policy`; top-level `defaultAccount`, `files`, `audit`. `policy`/`files`/`audit` are loose objects filled by later plans.
- `src/config/bundle-env.ts` — `applyBundleEnv` cleans the extension/plugin form environment: maps the switches `IMAP_MCP_ALLOW_SEND`/`IMAP_MCP_ALLOW_DELETE` onto `IMAP_MCP_PERMISSIONS` and splits `host:port` in the server fields (IPv6 only as a valid address, bare or in brackets).
- `src/config/load.ts` — `loadConfig(env, { secrets })`: `IMAP_MCP_CONFIG` file, or env-only single account (`IMAP_MCP_EMAIL`, `IMAP_MCP_IMAP_HOST`, …; `IMAP_MCP_DENY_FOLDERS` = comma-separated `policy.folders.deny`, the extension's `locked_folders` field), or `~/.imap-mcp/config.json` (`IMAP_MCP_HOME` overrides the directory). v1 files are migrated (password moved to the secret store, backup without password); the file is only rewritten once the password is safe — without a secret store, or when the old keytar entry cannot be read here, the migration stays in memory. `saveConfig()` writes atomically with mode 0600.
- `src/secrets/` — `SecretStore` chain: env vars first (`IMAP_MCP_PASSWORD_<ID>`, `*_FILE`, legacy `IMAP_PASSWORD` for `main`; refresh tokens are read from the keychain first, because rotation and sign-in store newer ones there), then the OS keychain: `createKeychainStore` uses `@napi-rs/keyring` (service `imap-mcp`, account `<id>:<key>`, Linux pinned to Secret Service) or, when the native module cannot load (MCPB bundle), the OS tools (`/usr/bin/security`, DPAPI files in `~/.imap-mcp/secrets`, `secret-tool`). `MigratingSecretStore` moves keytar-era secrets once; `lookupLegacyKeytarPassword` (found/absent/unknown) serves the v1 config migration. `MacSecurityStore` reads with `security find-generic-password -g` (`parseSecurityPassword`), because `-w` prints non-ASCII values as ambiguous bare hex. `MemorySecretStore` stages secrets during setup.
- `src/auth/provider.ts` — `AuthProvider` (`imapAuth`, `smtpAuth`, `invalidate`); password implementation caches the secret; `oauth2` accounts get `OAuthAuthProvider`. Env-only accounts choose the method with `IMAP_MCP_AUTH` (`src/config/env-auth.ts`).
- Microsoft 365 / Outlook.com sign-in is parked as a **preview** (owner decision O2 deferred 2026-10-17): `MICROSOFT_DEFAULT_CLIENT_ID` stays undefined, every organisation brings its own client ID, and Microsoft is not part of the 1.0 acceptance gate. Keep the code and tests.
- `src/auth/oauth/` — PKCE loopback sign-in (`flow.ts`; `listenHost`/`port` for containers, `openBrowser: false` for headless), Microsoft device-code fallback, token client, `OAuthAuthProvider` (2-minute expiry skew, single-flight refresh, rotated refresh tokens persisted), `SignInManager` behind the `sign_in` tool (45 s per call, 5 min flow).
- `src/onboarding/` — provider presets + detection (domain table → MX → autoconfig → guess), certificate probe, connection test, `diagnose()` (plain-language de/en messages).

**Runtime:**
- `src/context.ts` — `AppContext` (accounts, `defaultAccountId`, `observers`, `resolveAccount`, `anyAccountAllows`) and per-account `AccountRuntime` (`getClient`, `getSendDeps` with a fresh SMTP connection per message, `identityFor`, `ownAddresses`). `AppContextDeps` are test seams.
- `src/imap-client.ts` — `ImapConnectionManager(endpoint, auth, accountId)`: reconnect with backoff, keep-alive, mutex; on a rejected login it refreshes credentials once and then stops (no account lockouts).
- `src/connection-security.ts` — implicit TLS on 993/465, mandatory STARTTLS elsewhere (loopback excepted unless pinned), TLS ≥ 1.2; certificate pinning (`TlsPin`, `pinnedTlsOptions`): the pinned certificate is the only trust anchor and its SHA-256 fingerprint replaces the hostname check. `ConfigSchema` validates pins with `pinProblem()`.

**IMAP layer (`src/imap/`):** `strict.ts` (fail-closed wrappers incl. `strictStatus`; imapflow resolves refusals to `false`/`undefined`), `folders.ts` (`resolveFolder`, special folders), `search-query.ts` (`searchFilterShape`, `compileSearch`), `flags.ts`.

**Mail layer (`src/mail/`):** `compose.ts` (MailComposer), `headers.ts`, `reply.ts`, `identity.ts` (`fromHeader`, `withSignature`), `send.ts` (`deliver()`, Sent-copy policy, `MailTransport`), `parse.ts` (`parseMail` with `skipHtmlToText`; never call `simpleParser` directly — guarded by `policy-coverage.test.ts`).
- `src/mail/visible-text.ts` — what a human sees: `visibleHtml` (removes hidden elements judged from inline styles, presentational attributes and simple `<style>` rules, plus comments/`<noscript>`; cleans attribute values — tag characters removed, other invisible characters percent-encoded in `href`/`src`/`srcset` and stripped elsewhere; walks iteratively, unwraps nesting beyond 500 levels), `stripInvisible` (zero-width, bidi and tag characters; emoji ZWJ sequences and subdivision flags kept), `visibleString` (for subjects, names, file names), `stripTagCharacters` (tag characters only, for Message-IDs and `List-Unsubscribe`; addresses are never changed). What is removed comes back as `hiddenText`. Never run `visibleHtml` twice on the same HTML (a second pass no longer sees the removed `<style>` rules). Hostile input must stay linear: unambiguous number regexes, style sheets over `MAX_STYLE_CHARS` (64 KiB) are not evaluated at all (then only the `hidden` attribute counts), values over 256 characters count as not understood, rules are pre-merged per selector key; `src/mail/__tests__/hostile-input.test.ts` holds the time budgets. Anything not understood (colour, translucent background, font size) is never judged hidden.

**Tools (`src/tools/`):** every tool is registered through `defineTool()` (`src/tools/shared/define-tool.ts`), which builds a strict input schema (unknown parameters fail instead of being dropped — use `z.strictObject` for nested objects such as `filter` too), adds the optional `account` parameter, registers the tool only if some account grants its tier, checks the selected account's tier on every call, maps exceptions to `errorResult`, and notifies `app.observers` with `inv.record()` details. Tool modules export `register(server, app)`; add new tools to `ALL_TOOLS`.

| Tier | Default | Tools |
|------|---------|-------|
| always | — | list_accounts, health_check, sign_in |
| `read` | on | list_folders, search_emails, read_email, get_thread, get_email_count, download_attachment, get_quota, summarize_senders |
| `write` | on | mark_as_read, move_email, flag_email, organize_by_filter, create_draft, reply_draft, forward_draft, save_attachment, create/delete/rename_folder |
| `send` | off | send_email, send_draft |
| `delete` | off | delete_email |

Compose tools accept `from` (must be one of the account's identities) and `signature` (default true). `flag_email` refuses `\Deleted`. Moving into Trash (or below it) with `move_email`/`organize_by_filter`, or moving a folder there with `rename_folder`, counts as deleting: it needs the delete tier and `bulk.maxDelete` (`src/policy/trash-move.ts`). Nothing deletes mail permanently: `delete_email` only moves into Trash and refuses in Trash or below it (`checkNotInTrash`), and `send_draft` expunges the sent draft only when Sent holds a copy (otherwise it moves it to Trash). New folder names go through `serverFolderPath()` (namespace prefix) before policy checks; pass an already listed `folders` array to `resolvePolicyFolder`/`requireSpecialFolder` instead of listing again. Every tool has a `title` and explicit `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`; send tools are destructive and open-world.

**Daily-business modules (Plan 3):**
- `src/imap/select.ts` — `selectByFilter` (compile + `strictSearch` + client-side attachment filter, fail-closed), `keywordsSupported`. Filters include `gmailQuery` (X-GM-RAW, Gmail only; refused elsewhere).
- `src/imap/senders.ts` — `summarizeSenders` (envelope-only counts per address/domain) behind `summarize_senders` (newest `SENDER_SCAN_LIMIT` = 5000) and the `topSenders` of bulk previews.
- `src/mail/preview.ts` — `previewFor`: partial BODY.PEEK of the first text part (4 KiB plain / 16 KiB HTML), QP/base64 + charset decoding, HTML→text. Previews and `fullText` drop newsletter preheader padding (`PREHEADER_PADDING_GLOBAL` in `security/patterns.ts`), which the injection scan ignores as well.
- `src/mail/text.ts` — `fullText` (the text the reader sees: the text part, or the visible HTML text with `textPartDiffers` when one has at least `TEXT_PART_EXTRA_WORDS` = 5 distinct words the other lacks; `hidden` report; `hiddenText` = removed text plus a dropped text part, for the scanner only and never returned, logged or recorded), `pageText`/`boundedText` (paging without splitting surrogate pairs), `truncate`, `stripQuotedHistory`. Mail strings that reach the model go through `fullText`/`visibleString`.
- `src/mail/thread.ts` — `threadIds`, `threadQuery` (Message-ID/References/In-Reply-To header searches); `get_thread` uses the Gmail thread id in `\All` when available.
- `src/mail/forward.ts` — forward subject/header block; `src/mail/answered.ts` — `markOriginalAnswered` after `send_draft` (best effort, `originalFolder` from `reply_draft`).
- `src/bulk/selection.ts` + `src/bulk/run.ts` — preview (count, `topSenders`, sample) → single-use `confirmToken` (10 min, in memory; bound to account, folder, UIDVALIDITY, UID-set hash, action) → `commitBulk`; cap `bulkLimit()` = 500. Used by `organize_by_filter` and `delete_email` filter mode. Moves report `uidMapping` only up to 50 messages (`src/tools/shared/uid-mapping.ts`).
- `src/files/sandbox.ts` — real-path containment for `files.attachmentDirs`, filename sanitising, blocked executable/macro types, no-overwrite targets in `files.downloadDir`; `src/files/attachments.ts` — `{ path }` or base64 attachments for compose tools.
- `download_attachment` returns only text (≤ `files.maxInlineTextBytes`; HTML and AMP parts as visible text with `convertedFromHtml`) and images (≤ `files.maxInlineImageBytes`); everything else goes through `save_attachment` (write tier), which saves under the visible file name.

**Security layer (src/security/):** `patterns.ts`, `unicode-normalizer.ts`, `injection-detector.ts` (`scanForInjection`, `scanSubjectOnly`). The scanner reads what the model reads plus `hiddenText` as location `"hidden"`; findings there carry a placeholder snippet and never quote it. Every pattern is `strong` (3 points) or `generic` (1); `computeRiskLevel` counts each pattern once per message (`findingKey`: type plus description without counts) — 1 low, 2 medium, 3–4 high, ≥ 5 critical. Only letter-like Unicode trick characters count (no flags, emoji or fullwidth punctuation; fullwidth letters not in CJK text). Below `high` the `sanitizedPreview` is a weak hint. Keep regexes free of overlapping quantifiers (`src/security/__tests__/hostile-input.test.ts`).

**Policy and audit (src/policy/, src/audit/):**
- `policy/schema.ts` — strict `PolicySchema` per account (send mode drafts-only/confirm/direct, recipient allow/block lists, rate limits, folder allow/deny globs, bulk caps, protected folders, attachment limits); unknown keys fail.
- `policy/engine.ts` — `PolicyEngine` (attached as `AccountRuntime.policy`); every violation throws `PolicyDeniedError`, which `defineTool` reports as outcome `"denied"`. `tierAllowed` hides the send tier for drafts-only accounts.
- `policy/folder-access.ts` — tools use `resolvePolicyFolder`/`visibleFolders`, never `resolveFolder` directly (guarded by `src/__tests__/policy-coverage.test.ts`).
- `policy/folder-rules.ts` — `folderAllowed`/`folderDenied`: deny hides the match and every folder below it, a bare name matches at any depth (a leading `/` anchors it), a leading `INBOX/` in the path (and in deny patterns) is ignored; allow matches each folder by itself and literally.
- `policy/outbound.ts` — `guardOutbound` runs before every `deliver()`: recipients, rate limit, new-recipient check, injection escalation, confirmation. The injection escalation (a read at `confirmAfterInjectionRisk`, default `high`, within the last hour) only adds a warning line to the dialog in `confirm` mode and forces the dialog in `direct` mode (`forced`; refused as `send.injectionEscalation` without one); `required` is `forced || requireElicitation`. Right before `deliver()` the send tools call `policy.reserveSend()` (`SendCounter.reserve`: check + count in one step under the cross-process lock in `src/file-lock.ts`) and `release()` it when delivery throws — no counter I/O may follow a successful send.
- `policy/confirm.ts` — human confirmation via SDK v2 `inputRequired` elicitation; the answer is bound to an HMAC-signed digest of the exact operation. No model-visible confirm tokens for sending. Unknown client capabilities (stateless HTTP with a 2025-era client) refuse instead of falling back to client approval; `checkHttpDeployment` warns about confirm-mode accounts.
- `audit/audit-log.ts` — hash-chained JSONL audit log (`~/.imap-mcp/audit/`), cross-process lock, retention; check with `inbox-warden audit verify` (`src/cli/audit.ts`).
- `logging/redact.ts` — secrets and message content never reach logs; `IMAP_MCP_PROTOCOL_LOG=1` enables a redacted IMAP protocol log for troubleshooting.

**Remote transport (src/transport/, Plan 7):**
- `http-app.ts` — fetch-style router: `/healthz`, RFC 9728 metadata, `/mcp` → Host/Origin checks → IP allowlist → `HttpAuthenticator` → principal → mailbox mapping → rate limit → SDK v2 `createMcpHandler` with a fresh `createRemoteServer(scopedApp)` per request (= `createServer(app, { exclude: LOCAL_ONLY_TOOLS })`, so `sign_in` is never offered remotely; add any future tool that acts on the server machine to `LOCAL_ONLY_TOOLS` in `src/server.ts`). `http-server.ts` adapts it to `node:http` via `@hono/node-server`. `http-runtime.ts` composes config, auth and app; `checkHttpDeployment` (src/config/http-schema.ts) decides whether `serve --http` may start.
- `auth/bearer.ts` (hashed tokens), `auth/oauth.ts` (jose JWT validation, JWKS discovery), `auth/metadata.ts` (protected resource metadata, WWW-Authenticate), `auth/principals.ts` (caller → mailbox rules, `scopeAppContext` adds `principal` to audit events), `auth/authenticator.ts`, `guards.ts` (client IP, CIDR, rate limiter, security headers).
- Start-up: `serve(args)` in `src/serve.ts` hands `--http` to `src/cli/serve-http.ts` (`startServeHttp`: runtime secret store, host autodetection, `setupAudit`, then the listener; `runServeHttp` waits for SIGINT/SIGTERM). The `http` command (`src/cli/dispatch.ts`, `src/cli/program.ts`) runs `runHttpCli` from `src/cli/http-command.ts`.
- `src/secrets/container.ts` — container secret store (env + `*_FILE` + AES-GCM state file, never keychain); `serve`, `serve --http`, `http` and Plan 4's admin CLI (`CliDeps.createSecrets`) all use `createRuntimeSecretStore`.
**Key patterns:**
- Product name and version come from `src/version.ts` (`SERVER_NAME`, `VERSION`, read from package.json); never hard-code them.
- Register tools only with `defineTool`; get IMAP clients and SMTP deps from `inv.account`.
- Never call imapflow's `search`, `status`, `messageMove`, `messageCopy`, `messageFlagsAdd/Remove`, `messageDelete`, `append` or `download` directly from a tool — use `src/imap/strict.ts`. Every path that lists, reads or changes messages passes a `MessageScope` (`inv.account.policy.messageScope(folders)`) to `existingUids`, `selectByFilter`, `downloadMessage` or `visibleUids`: on Gmail it hides messages carrying a locked label as if they did not exist (`src/policy/label-lock.ts`); `UNSCOPED` only outside an account policy. Wrap `mailboxRename`/`mailboxDelete` in `withoutImplicitExpunge` (imapflow deselects with CLOSE, an implicit expunge, on servers without UNSELECT).
- Never pass a folder name from tool input straight to imapflow — use `resolveFolder` / `requireSpecialFolder`.
- A tool must never select more messages than requested; responses echo what was applied.
- Build messages only with `composeMessage`, sender via `fromHeader(identity)`; send only with `deliver()`.
- zod 4: `z.record(keySchema, valueSchema)`, `z.email()`, `.prefault({})` for object defaults.
- Logs go to stderr; never log message bodies or secrets.
- Parse mail only with `parseMail`; every string a tool returns from mail content goes through `fullText`, `visibleString` or `stripTagCharacters` (results of draft tools too, never the draft itself); hidden text is for the scanner only.
- Error messages say whether anything was changed.

**Testing:**
- `createTestApp(accounts?, config?)` (`src/__tests__/helpers/test-app.ts`) builds an `AppContext` on `FakeImap` + capture transports (default account `main`, all tiers on); `t.connect(...registers)` returns a `Harness` talking to the server over the SDK v2 `InMemoryTransport`.
- `FakeImap` mimics imapflow including soft failures (`failOn(method, "false" | "throw")`), `quota`, `mailboxRename` (moves subfolders) and imapflow's MOVE fallback (COPY + plain EXPUNGE once `MOVE`/`UIDPLUS` are deleted from `capabilities`). `t.stateDir` is where the send counters live.
- `createCaptureTransport()` behaves like SMTP (Bcc stripped) and records messages.
- `buildRaw()` builds fixture messages; `header()` reads a header from raw bytes.
- Integration tests (`src/__tests__/integration/`) run against GreenMail; CI runs them on every push.
