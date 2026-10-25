# Extension with Setup Mailboxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Claude Desktop extension (and the Claude Code plugin, which runs the same `.mcpb`) uses every mailbox set up with `inbox-warden setup` when the form's email address is left empty.

**Architecture:** The server already loads `~/.imap-mcp/config.json` when `IMAP_MCP_EMAIL` is unset. What is missing: the bundle (no native modules) cannot read the passwords the command-line version stores in the Windows Credential Manager, the form marks the address as required, and the form's switches and fields would be silently ignored. This plan adds a Credential Manager store on Windows using PowerShell, makes the address optional, and turns the form's switches and locked folders into limits that apply to every setup mailbox.

**Tech Stack:** TypeScript (ES modules), Node ≥ 20.19, zod 4, vitest, Windows PowerShell 5.1 (`Add-Type` P/Invoke into `advapi32`), MCPB manifest 0.3.

**Spec:** the Decisions section below. The owner chose option A on 2026-10-25 ("Adresse leer lassen → CLI-Konten") and skipped the design questions, so there is no separate design document.

## Decisions

- **D1 Credential Manager on Windows without native modules.** `@napi-rs/keyring` stores secrets as generic credentials. Checked on 2026-10-25 with a probe entry: Type 1 (`CRED_TYPE_GENERIC`), Persist 3 (`CRED_PERSIST_ENTERPRISE`), Flags 0, no comment, no alias, no attributes, `TargetName` = `<accountId>:<key>.imap-mcp`, `UserName` = `<accountId>:<key>`, blob = the secret in UTF-16LE without a BOM. The bundle's Windows fallback reads and writes exactly that, using `CredReadW`/`CredWriteW`/`CredDeleteW` from a PowerShell `Add-Type` snippet, so the command-line version and the bundle share entries, as they already do on macOS and Linux. The target name and the secret go in on stdin and never on the command line. One lookup takes about 0.45 s.
- **D2 Legacy DPAPI files keep working.** Older bundles may have written `~/.imap-mcp/secrets/<id>.<key>.dpapi`. Reading checks the Credential Manager first, then that file. Writing goes to the Credential Manager and then removes the file. Deleting removes both.
- **D3 Empty address = setup mailboxes.** In the manifest, `email` becomes `required: false`. With the form present (the switch variables exist) and no address, `applyBundleEnv` switches to *setup mode*:
  - It drops the fields that only describe the form's own mailbox: password, login name, name, both servers and ports, and the lookup switch. In particular, a leftover form password must never reach an account called `main` through `IMAP_MCP_PASSWORD`.
  - It does not refuse a missing password.
  - It does not validate leftover server fields.
- **D4 Switches are an upper limit.** In setup mode, the two switches become `IMAP_MCP_MAX_PERMISSIONS=read,write[,send][,delete]` instead of `IMAP_MCP_PERMISSIONS`. `loadConfig` caps every file account by it: a tier stays on only if the account has it **and** the list names it. So a switch that is off in the form is off for every mailbox, and a switch that is on allows what each account's own configuration allows. Never more than either side says.
- **D5 Locked folders are added to every mailbox.** For file configurations, the patterns in `IMAP_MCP_DENY_FOLDERS` (validated by the existing `denyFoldersFromEnv`) are added to each account's `policy.folders.deny`, keeping the existing order and dropping duplicates. Only more gets locked, never less.
- **D6 Attachment and download folders from the form win when set.** For file configurations, `IMAP_MCP_ATTACHMENT_DIRS` replaces `files.attachmentDirs` and `IMAP_MCP_DOWNLOAD_DIR` replaces `files.downloadDir` when the variable is set. When it is unset, the file's value stays. (`setup` does not write `files`, so in practice the form decides.)
- **D7 The env limits apply to every file configuration.** D4–D6 apply whenever the variables are set, so containers with a config file get the same safe direction. `IMAP_MCP_MAX_PERMISSIONS` is new and gets documented.
- **D8 Setup-problem advice for setup mode.** `applyBundleEnv` marks setup mode with `IMAP_MCP_FORM=setup`. When the server cannot start in that mode, the advice reads: enter an address and password in the settings, or set up mailboxes with the command-line version (`npm install -g inbox-warden`, `inbox-warden setup`; needs Node.js 20.19+) and leave the address empty, then save and open a new chat (Desktop) or Reconnect (Claude Code).
- **D9 Copy.** Form titles stay English and self-explanatory, with no "/" in titles (existing test).
  - `email` title: `Email address (leave empty for mailboxes from setup)`.
  - `email` description: `The mailbox Claude may use, e.g. office@your-company.at. Leave it empty to use every mailbox set up with the command-line version (inbox-warden setup); the password, name and Advanced fields are then not used, and the two switches and the locked folders apply to every mailbox.`
- **Non-goals:**
  - setting up mailboxes from inside the extension or without Node.js
  - per-mailbox switches in the form
  - shipping native keyring binaries in the bundle
  - Linux bundles (not a supported platform)
- **Anti-goals:**
  - the form shows a lock or an "off" switch that does not apply
  - a form password ends up used for a setup mailbox
  - a secret appears on a command line or in a log

## Global Constraints

- No native binaries in the bundle (`scripts/build-mcpb.mjs` refuses them). The Windows fallback uses only `powershell.exe` (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, as `POWERSHELL` today).
- Secrets go to child processes only on stdin. `runCommand` never uses a shell.
- Error messages say whether anything was changed. Never log message content or secrets.
- `SERVER_NAME`/`VERSION` come from `src/version.ts`. Never hard-code them.
- Credential blob limit: 2,560 bytes (`CRED_MAX_CREDENTIAL_BLOB_SIZE`), i.e. 1,280 UTF-16 code units. A longer secret is refused before PowerShell runs.

## Review Focus

1. The owner clears the address in an existing extension but leaves the password filled, and `config.json` has an account `main` → the keychain password is used, not the form's (Task 3 test).
2. A leftover invalid server entry (`imap.x:abc`) with an empty address → the server starts and the entry is ignored (Task 3 test).
3. A password with umlauts, `€` and an emoji written by the command-line version → the bundle reads the same string (Task 1 real round trip and unit test).
4. PowerShell is blocked (Constrained Language Mode, AppLocker) → a clear `SecretStoreUnavailableError`, no hang and no secret in the message (Task 1 test: exit code 1 with stderr).
5. Locked folders in the form plus a different lock in `config.json` → both locked for that account, and the form's lock applies to the other accounts too (Task 2 test).

---

### Task 1: Windows Credential Manager store for the bundle

**Files:**
- Modify: `src/secrets/os-cli-store.ts` (new `WindowsCredentialStore`; `createCliSecretStore` returns it on win32)
- Test: `src/secrets/__tests__/os-cli-store.test.ts`

**Interfaces:**
- Produces: `export class WindowsCredentialStore implements SecretStore { constructor(secretsDir: string, run?: RunCommand, powershell?: string) }`. `WindowsDpapiStore` stays exported and is used inside it for D2.
- Produces: `createCliSecretStore({ platform: "win32", … })` → `WindowsCredentialStore`.

- [ ] **Step 1: Write the failing tests** (scripted `run`, like the existing `WindowsDpapiStore` test)
  - `"reads the generic credential <id>:<key>.imap-mcp via PowerShell and decodes UTF-16LE"`: the script returns stdout = base64 of `Buffer.from(SECRET, "utf16le")`. Expect `get("main","password")` → `SECRET`. The call's stdin starts with the target `main:password.imap-mcp`, and the args are `["-NoProfile","-NonInteractive","-Command", <script containing "CredReadW">]`.
  - `"writes UTF-16LE with the target and user name @napi-rs/keyring uses, secret only on stdin"`: `set("main","password",SECRET)`. The stdin holds the target, the user name `main:password` and base64 of the UTF-16LE secret. No arg contains that base64 or `SECRET`. The script contains `CredWriteW` and `Persist = 3`.
  - `"maps 'not found' to null and falls back to a legacy DPAPI file"`: the first call exits with code 3 → falls back to the `<dir>/main.password.dpapi` blob (second call = DPAPI unprotect) → `SECRET`. With no file → `null`.
  - `"removes the legacy DPAPI file after writing and deletes both"`: after `set` the file is gone; `delete` calls `CredDeleteW` (exit 3 accepted) and removes the file.
  - `"refuses an odd-length blob and a secret over 1,280 UTF-16 units"`: both throw `SecretStoreUnavailableError`. The long one runs no command.
  - `"reports a blocked PowerShell without quoting the secret"`: exit code 1 with stderr `"Cannot invoke method. Method invocation is supported only on core types in this language mode."` → `SecretStoreUnavailableError` whose message contains `language mode` and not `SECRET`.
  - Real round trip, `it.skipIf(process.platform !== "win32" || process.env.IMAP_MCP_KEYCHAIN_IT !== "1")`: `"shares entries with @napi-rs/keyring in both directions"`. Write `"Dümmy€😀 'q' \"x\""` with `KeyringSecretStore` under the account id `iw-it-<random>`, read it with `new WindowsCredentialStore(tmpdir, runCommand)`. Then write with the store and read with keyring. Delete both in `finally`. Timeout 30 s.

- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/secrets/__tests__/os-cli-store.test.ts`
  Expected: FAIL, `WindowsCredentialStore` is not exported.

- [ ] **Step 3: Implement `WindowsCredentialStore`**
  - One C# type through `Add-Type -TypeDefinition` (class `InboxWardenCredential`, `CREDENTIAL` struct with `CharSet.Unicode`, `CredReadW`/`CredWriteW`/`CredDeleteW`/`CredFree` from `advapi32.dll`, `SetLastError = true`), shared by three scripts: READ, WRITE, DELETE.
  - Each script reads stdin lines: line 1 = target, and for WRITE line 2 = user name and line 3 = base64 blob.
  - On success, READ prints the blob as base64.
  - Win32 error 1168 (`ERROR_NOT_FOUND`) → exit 3. Any other failure → `[Console]::Error.Write("Win32 error <n>")` and exit 1.
  - WRITE sets `Type = 1`, `Persist = 3`, `Flags = 0`, and copies the blob into `Marshal.AllocHGlobal` memory, freed in `finally`.
  - Errors map through the existing `unavailable(what, result)`: "Reading the Windows Credential Manager", "Saving to …", "Deleting from …".

- [ ] **Step 4: Run the tests, including the real round trip**
  Run: `IMAP_MCP_KEYCHAIN_IT=1 npx vitest run src/secrets/__tests__/os-cli-store.test.ts` (on this Windows machine)
  Expected: PASS, with the round trip not skipped.

- [ ] **Step 5: Commit**
  `git commit -m "Read and write the Windows Credential Manager without the native keyring module"`

### Task 2: Env limits for file configurations

**Files:**
- Modify: `src/config/load.ts`: new `applyEnvLimits`, called on every config `loadConfig` returns from a file (v2 parse and v1 migration)
- Test: `src/config/__tests__/load.test.ts`

**Interfaces:**
- Consumes: `denyFoldersFromEnv(env)`, `filesFromEnv(env)` (existing)
- Produces: `export function applyEnvLimits(config: AppConfig, env: NodeJS.ProcessEnv): AppConfig`. It returns a new object and never mutates its input.
- Produces: the variable `IMAP_MCP_MAX_PERMISSIONS`, a comma list of `read|write|send|delete`. An unknown name throws `ConfigError` naming the variable.

- [ ] **Step 1: Write the failing tests** (`describe("limits from the environment for a config file")`)
  - `"caps every account's permissions by IMAP_MCP_MAX_PERMISSIONS"`: accounts `a` {read, write, delete} and `b` {read, write, send}, max `read,write,delete` → `a` keeps delete, `b` loses send.
  - `"adds IMAP_MCP_DENY_FOLDERS to every account, after the file's own locks, without duplicates"`: `a.policy.folders.deny = ["_NDA_Inbox"]`, env `"_NDA_Inbox, Privat"` → `a`: `["_NDA_Inbox","Privat"]`, `b`: `["_NDA_Inbox","Privat"]`.
  - `"lets set attachment and download folders replace the file's and keeps the file's otherwise"`.
  - `"changes nothing when none of the variables is set"` (`toEqual` the parsed file).
  - `"rejects an unknown permission in IMAP_MCP_MAX_PERMISSIONS and names the variable"`.
  - `"is applied by loadConfig to a config file"` (temp `IMAP_MCP_HOME` with a v2 file, like `"loads an existing v2 file unchanged"`).

- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/config/__tests__/load.test.ts`
  Expected: FAIL, `applyEnvLimits` is not exported.

- [ ] **Step 3: Implement `applyEnvLimits`** and call it in `loadConfig` on both file paths (not in `configFromEnv`, which already reads these variables).

- [ ] **Step 4: Run the tests**
  Run: `npx vitest run src/config/__tests__/load.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "Apply the form's limits to every mailbox of a config file"`

### Task 3: Setup mode in the bundle environment and its start-up advice

**Files:**
- Modify: `src/config/bundle-env.ts` (setup mode, D3/D4/D8)
- Modify: `src/setup-problem.ts` (third advice branch)
- Test: `src/config/__tests__/bundle-env.test.ts`, `src/__tests__/setup-problem.test.ts`

**Interfaces:**
- Consumes: `IMAP_MCP_MAX_PERMISSIONS` semantics (Task 2)
- Produces: in setup mode, `applyBundleEnv` sets `IMAP_MCP_FORM=setup` and `IMAP_MCP_MAX_PERMISSIONS`, and deletes `IMAP_MCP_PASSWORD`, `IMAP_MCP_USERNAME`, `IMAP_MCP_DISPLAY_NAME`, `IMAP_MCP_IMAP_HOST`, `IMAP_MCP_IMAP_PORT`, `IMAP_MCP_SMTP_HOST`, `IMAP_MCP_SMTP_PORT` and `IMAP_MCP_NO_AUTOCONFIG` before any port or host validation. Setup mode = (`IMAP_MCP_ALLOW_SEND` or `IMAP_MCP_ALLOW_DELETE` present) and no address after cleaning.

- [ ] **Step 1: Write the failing tests**
  - bundle-env `"uses the setup mailboxes when the form's address is empty"`:
    - Input: email placeholder `"${user_config.email}"`, password `"old"`, display name `"Max"`, `IMAP_MCP_IMAP_HOST: "imap.x:abc"`, `IMAP_MCP_ALLOW_SEND: "false"`, `IMAP_MCP_ALLOW_DELETE: "true"`, `IMAP_MCP_DENY_FOLDERS: "_NDA_*"`.
    - Expected env: `{ IMAP_MCP_FORM: "setup", IMAP_MCP_MAX_PERMISSIONS: "read,write,delete", IMAP_MCP_DENY_FOLDERS: "_NDA_*" }`, with no throw.
  - bundle-env `"does not treat a container without the form's switches as setup mode"`: `{ IMAP_MCP_CONFIG: "/c.json", IMAP_MCP_PASSWORD_MAIN: "x" }` stays unchanged.
  - bundle-env, end to end (pattern of the existing loadConfig tests in this file): temp `IMAP_MCP_HOME` with a v2 file holding account `main` {read, write, send}, and a `MemorySecretStore` with `main/password = "from-keychain"`.
    - Setup-mode env with form password `"from-form"` and both switches off.
    - Expected: `createSecretStore`-style chain `get("main","password")` → `"from-keychain"`, and `main` permissions → read, write only.
  - setup-problem `"advises setup mailboxes or an address in setup mode"`: `answer` text with env `{ IMAP_MCP_FORM: "setup" }` contains `leave the address empty`, `inbox-warden setup`, `Configure` and `Reconnect`. The existing form and terminal branches stay unchanged.

- [ ] **Step 2: Run to verify they fail**
  Run: `npx vitest run src/config/__tests__/bundle-env.test.ts src/__tests__/setup-problem.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement setup mode in `applyBundleEnv`** (right after the placeholder cleanup) and the advice branch in `setup-problem.ts`. `formSetup` stays as it is. Setup mode is checked first. The copy is D8, built with `SERVER_NAME`.

- [ ] **Step 4: Run the tests**
  Run: `npx vitest run src/config/__tests__/bundle-env.test.ts src/__tests__/setup-problem.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git commit -m "Use the setup mailboxes when the extension's address is left empty"`

### Task 4: Manifest, documentation, changelog

**Files:**
- Modify: `mcpb/manifest.json` (`email.required: false`, D9 title and description; `long_description`: "one mailbox" → "your mailboxes", plus the sentence `Several mailboxes, Microsoft 365 or Google Workspace sign-in: set them up once with the command-line version and leave the email address empty (see Documentation).`)
- Modify: `scripts/__tests__/mcpb.test.mjs` (D5 title list, `email` `required: false`)
- Modify: `README.md` (install table row "Several mailboxes in one installation": extension and plugin "✓ (set up with the command line)"; a Claude Desktop step-3 sentence)
- Modify: `docs/guide/en/README.md`, `docs/guide/de/README.md`: the "Several mailboxes" section gets "In the Claude Desktop extension or the Claude Code plugin". It explains:
  - leave the address empty
  - Node.js is needed once
  - the switches are an upper limit for every mailbox
  - the locked folders apply to every mailbox
  - on macOS, allow access to the keychain item once ("Always Allow")

  The permissions section gets one sentence on the upper limit. The troubleshooting table gets a row for "No configuration found at …" (fix: run setup or enter the address).
- Modify: `CHANGELOG.md` `[Unreleased]` → `### Added` (setup mailboxes in the extension and plugin, `IMAP_MCP_MAX_PERMISSIONS`) and `### Changed` (`IMAP_MCP_DENY_FOLDERS`, `IMAP_MCP_ATTACHMENT_DIRS` and `IMAP_MCP_DOWNLOAD_DIR` also apply to config files; the Windows bundle reads the Credential Manager).
- Modify: `CLAUDE.md` (bundle-env setup mode, `applyEnvLimits`, `WindowsCredentialStore` in the secrets paragraph)

- [ ] **Step 1: Update the manifest test first, run it, and see it fail**
  Run: `npx vitest run scripts/__tests__/mcpb.test.mjs`
  Expected: FAIL on the title and `required`.
- [ ] **Step 2: Change the manifest and the docs**
- [ ] **Step 3: Run `npx vitest run scripts/__tests__/mcpb.test.mjs` and `node scripts/check-docs.mjs`**
  Expected: PASS, and "all local links resolve".
- [ ] **Step 4: Commit**
  `git commit -m "Document the extension's setup mailboxes"`

### Task 5: Whole-branch verification with the built bundle

- [ ] **Step 1:** Run `npm run build && npm run typecheck && npm test`. Expected: all green.
- [ ] **Step 2:** Run `npm run build:mcpb && npm run smoke:mcpb && npm run check:mcpb-zip`. Expected: green, and the bundle has no `keyring-win32-*` package (the fallback is really used).
- [ ] **Step 3: Real check on the owner's machine**
  - Start `build/mcpb/server/preflight.cjs serve` with the env Claude Desktop passes when the address is empty (the email and password placeholders unexpanded, `IMAP_MCP_ALLOW_SEND=false`, `IMAP_MCP_ALLOW_DELETE=true`, `IMAP_MCP_DENY_FOLDERS=_NDA_Inbox`).
  - Over stdio, run `list_accounts`. Expected: `maxigmail` (delete off, from its config) and `dev-mailbox` (delete on).
  - Run `health_check`. Expected: both connected, which proves the passwords come from the Credential Manager.
- [ ] **Step 4:** Pack the dev bundle (`npx @anthropic-ai/mcpb pack build/mcpb …`, as in the release workflow) and copy it to `Downloads\inbox-warden-dev-setup-mailboxes.mcpb` for the owner's Desktop test.
