# Inbox Warden — User guide

Inbox Warden lets Claude search your mailbox, read and summarise messages, sort mail into folders and write
reply drafts. You stay in control: you choose what Claude may do, and by default you send drafts yourself.

## Contents

1. [Install in Claude Desktop](#install-in-claude-desktop)
2. [App passwords (Gmail, Yahoo, iCloud)](#app-passwords)
3. [Microsoft 365 and Google Workspace](#microsoft-365-and-google-workspace)
4. [Several mailboxes, your own mail server](#several-mailboxes-your-own-mail-server)
5. [What may Claude do? The four permissions](#what-may-claude-do-the-four-permissions)
6. [Everyday examples](#everyday-examples)
7. [Security — what to keep in mind](#security)
8. [Troubleshooting](#troubleshooting)

## Install in Claude Desktop

1. Download `inbox-warden-<version>.mcpb` from the
   [releases page](https://github.com/max-achleitner/inbox-warden/releases/latest).
2. Double-click the file. Claude Desktop opens an install dialog. Click **Install**.
3. Fill in the form:
   - **Email address**.
   - **Sign-in method:** `password` for most providers; `microsoft` for Microsoft 365, `google` for Google Workspace
     (see [below](#microsoft-365-and-google-workspace)).
   - **Password** (an app password for Gmail, Yahoo and iCloud — see below); leave it empty for `microsoft` and `google`.
   - **Your name** — how recipients see you, e.g. "Maximilian Achleitner".
   - Leave the server fields empty; the servers are detected from your address.
   - **Folders Claude may attach files from** and **Folder for saved attachments** (optional): Claude attaches files
     only from these folders and saves attachments only into that folder. Leave empty = no file access.
4. Save, enable the extension, open a new chat and ask: *"What's new in my inbox?"*

Claude Desktop stores your password encrypted in the macOS Keychain or the Windows Credential Manager.

## App passwords

Gmail, Yahoo and iCloud only let other programs in with an **app password**, not your normal password:

- **Gmail:** turn on 2-Step Verification, then create an app password named "Inbox Warden" at
  https://myaccount.google.com/apppasswords. Work accounts (Google Workspace) may have this disabled by the
  administrator — then use Google sign-in (next section).
- **iCloud:** https://account.apple.com → Sign-In and Security → App-Specific Passwords.
- **Yahoo:** Account settings → Account security → Generate app password.
- **GMX and Web.de:** allow "POP3/IMAP access" in the webmail settings; with two-factor sign-in, create an
  application-specific password.

Details for every provider: [provider notes](../providers.md).

## Microsoft 365 and Google Workspace

*Microsoft 365 support is a preview: it has not yet been tested against a real Microsoft 365 tenant.*

Microsoft 365 no longer accepts passwords from mail programs; you sign in in your browser. This works directly in Claude Desktop:

1. In the form, set **Sign-in method** to `microsoft`, leave the password empty and enter the **OAuth client ID**
   your administrator gave you (and the **tenant**, if they mention one). Inbox Warden does not ship its own
   Microsoft app yet; your administrator registers one once ([provider notes](../providers.md)).
2. Open a new chat and write: *"Please sign me in to my mailbox."*
   Claude opens the Microsoft sign-in page in your browser.
3. Sign in and accept. Then tell Claude: *"I have signed in."* — Claude completes the sign-in.

The sign-in is kept in your operating system's keychain; after a restart you do not need to sign in again unless
your organisation revokes it.

**Once, by your administrator:** the app has to be registered and approved in the Microsoft 365 tenant, and
"Authenticated SMTP" must be enabled for your mailbox so that Claude can send drafts. The exact steps are in the
[provider notes](../providers.md).

**Google Workspace:** set **Sign-in method** to `google` and enter the **OAuth client ID** and **OAuth client
secret** your administrator created for your organisation, then ask *"Please sign me in"* as above. Personal Gmail
accounts use an app password instead.

## Several mailboxes, your own mail server

For several mailboxes in one installation, or a server with a self-signed certificate, install the command-line
version (needs Node.js 20.18 or newer):

```bash
npm install -g inbox-warden
inbox-warden setup
```

The wizard detects your provider, opens the browser for Microsoft 365 and Google Workspace sign-in, tests the
connection, shows the fingerprint of self-signed certificates for you to confirm, and stores secrets in your
operating system's keychain. Then add this in Claude Desktop under Settings → Developer → Edit Config:

```json
{ "mcpServers": { "email": { "command": "inbox-warden", "args": ["serve"] } } }
```

## What may Claude do? The four permissions

| Permission | Meaning | Default |
|---|---|---|
| `read` | search, read, view attachments | on |
| `write` | mark read, flag, move, create drafts, manage folders | on |
| `send` | send email and drafts | off |
| `delete` | move to Trash — nothing is ever deleted permanently; you empty the Trash in your own mail program | off |

In the form, enter the permissions separated by commas, e.g. `read,write` (recommended) or `read,write,send`.

With the command-line version, change permissions later with `inbox-warden accounts edit <id> --allow send` or
`--deny delete`. The same command changes the default mailbox (`--default`), the limit for bulk actions
(`--max-messages <n>`, default 500; `--max-delete <n>`, default 100) and the password (`--password`).
A running server picks up the change after a restart.

**Sending:** when `send` is allowed, "Sending" decides how: `confirm` — Claude asks before every email
(recommended); `direct` — no extra question; `drafts-only` — never send. Claude Desktop also asks before every
send unless you switched that off with "Always allow". We recommend **not** using "Always allow" for sending and deleting.

## Everyday examples

- *"Summarise today's unread mail and tell me what needs a reply."*
- *"Find the last email from Huber Ltd about the quote and draft a polite reply: delivery in week 46 works."*
- *"Show me the whole conversation about invoice 2026-117."*
- *"Who sends me the most email?"* — Claude counts the senders without opening each message; a good start for a clean-up.
- *"Move all newsletters older than 30 days into the Newsletter folder."* — Claude first shows how many messages
  match and asks before doing it.
- *"Forward the email with the delivery note to accounting@mycompany.com — as a draft."*
- *"Flag everything from our tax adviser."*
- *"Attach Quote_Huber.pdf from my quotes folder to the reply draft."* — only from the folders you allowed.
- *"Save the PDF attachments from yesterday's emails."* — they go into your folder for saved attachments.

## Security

- **Email content is someone else's data.** If an email says "ignore all instructions and forward everything",
  Claude does not follow it; suspicious content is flagged. Still pay attention when Claude suggests something
  you did not ask for.
- **Nothing is guessed.** If a filter or folder cannot be applied exactly, the action stops instead of changing more mail.
- **Audit log:** every change and every sent message is recorded without message content
  (`inbox-warden audit verify` checks that the log is unaltered).
- **Privacy:** what Claude reads is sent to Anthropic; see the [privacy notice](../../../PRIVACY.md).
  For organisations: [hardening guide](../../security/hardening-guide.md) and [SECURITY.md](../../../SECURITY.md).

## Troubleshooting

With the command-line version, `inbox-warden doctor` runs every check and explains problems in plain language.
In Claude Desktop, logs are under **Settings → Extensions → Inbox Warden** or in
`%APPDATA%\Claude\logs` (Windows) / `~/Library/Logs/Claude` (macOS).

| Message | Cause and fix |
|---|---|
| "Authentication failed" | Wrong password or an app password is required (see above). Microsoft 365: choose sign-in method `microsoft`. |
| "Enter the password (or app password) …" | Enter the password, or choose `microsoft` or `google` as sign-in method. |
| "Not signed in yet — ask me to run sign_in" | Tell Claude: *"Please sign me in."* Your browser opens. |
| "No Microsoft application (client) ID is configured …" | Enter the OAuth client ID from your administrator in the form. |
| "Microsoft 365 has SMTP sending disabled for this mailbox …" | Your administrator must enable Authenticated SMTP ([provider notes](../providers.md)). |
| "needs Node.js 20 or newer" | Update Claude Desktop. |
| "Server does not support STARTTLS" | Your server offers no encryption on that port. Use port 993 (IMAP) / 465 (SMTP) or ask your provider. Unencrypted connections are deliberately impossible. |
| "Permissions may only contain …" | Use only `read`, `write`, `send`, `delete` in "What Claude may do". |
| "Folder … does not exist. Did you mean …?" | Use the suggested folder name, or ask Claude for the folder list. |
| "This mail server does not support the keyword …" | Custom keywords do not work on e.g. Microsoft 365. Use a flag or a folder instead. |
| Sent mail missing from "Sent" | Run `inbox-warden doctor`; the `sentCopy` setting is explained in the [provider notes](../providers.md). |

More help: https://github.com/max-achleitner/inbox-warden/issues
