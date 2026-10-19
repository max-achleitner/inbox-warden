# Inbox Warden

**Email for Claude — safely.** Let Claude search, read, sort and draft your email in any mailbox
that speaks IMAP/SMTP: Gmail and Google Workspace, Microsoft 365 and Outlook.com (preview), GMX, Web.de, IONOS,
iCloud, Yahoo, or your own mail server.

*Deutsch:* [Benutzerhandbuch](docs/guide/de/README.md) · *English:* [User guide](docs/guide/en/README.md)

## Install — pick the way that fits you

| | Claude Desktop extension | Claude Code plugin | Command line (npm) |
|---|---|---|---|
| Install | double-click a file | two commands | `npm install -g` + `setup` |
| Password / app password (Gmail, GMX, IONOS, iCloud, own server …) | ✓ | ✓ | ✓ |
| Microsoft 365 sign-in (preview) | ✓ (ask Claude "please sign me in") | ✓ | ✓ |
| Google Workspace sign-in (your organisation's OAuth client) | ✓ | ✓ | ✓ |
| Several mailboxes in one installation | — | — | ✓ |
| Own server with a self-signed certificate (pinned) | — | — | ✓ |
| Needs Node.js on the computer | no | no | yes (20.19+) |

**Microsoft 365 and Outlook.com are a preview.** Inbox Warden does not ship its own Microsoft app yet, so your
administrator registers one once ([steps](docs/guide/providers.md#microsoft-365--exchange-online--for-the-administrator)),
and the Microsoft sign-in has not yet been tested against a real Microsoft 365 tenant.

### Claude Desktop (recommended for most people)

1. Download `inbox-warden-<version>.mcpb` from the [latest release](https://github.com/max-achleitner/inbox-warden/releases/latest).
2. Double-click the file. Claude Desktop shows an install dialog — click **Install**.
3. Enter your email address and choose the sign-in method:
   - `password` (default): enter your password; Gmail, Yahoo and iCloud need an
     [app password](docs/guide/en/README.md#app-passwords).
   - `microsoft` (Microsoft 365, preview) or `google` (Google Workspace): leave the password empty, enter the
     OAuth client ID from your administrator, then ask Claude
     *"Please sign me in"* — your browser opens the sign-in page. See
     [Microsoft 365 and Google Workspace](docs/guide/en/README.md#microsoft-365-and-google-workspace).

   Leave the server fields empty; they are detected from your address.
4. Start a new chat: *"What's new in my inbox?"*

Passwords are stored encrypted by Claude Desktop, sign-ins in your operating system's keychain. By default Claude
can read and create drafts, but cannot send or delete — you send drafts from your mail program.

**Team and Enterprise administrators** can upload the bundle once for the whole organisation
(Organization settings → Connectors → Desktop), allow-list it, and require signed extensions
(`isDesktopExtensionSignatureRequired`). See [Verify downloads](#verify-downloads) and the
[hardening guide](docs/security/hardening-guide.md).

### Claude Code

```bash
claude plugin marketplace add max-achleitner/inbox-warden
claude plugin install inbox-warden@achleitner
```

Then `/plugin` → **inbox-warden** → **Configure**. The plugin adds skills for inbox triage,
reply drafting and mailbox clean-up.

### Command line (several mailboxes, own certificates)

Requires Node.js 20.19 or newer.

```bash
npm install -g inbox-warden
inbox-warden setup     # guided: detects your provider, signs in, tests the connection, stores secrets in the OS keychain
inbox-warden doctor    # checks everything and explains problems in plain language
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "email": { "command": "inbox-warden", "args": ["serve"] } } }
```

Claude Code: `claude mcp add email -- inbox-warden serve`

## Remote mode (HTTPS) — optional

Need claude.ai in the browser, colleagues sharing one server, or scheduled automations while your PC is off? Run the server remotely with Docker behind Caddy:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
claude mcp add --transport http mail https://mail.example.com/mcp --header "Authorization: Bearer imcp_…"
```

Authentication is mandatory: bearer tokens (`inbox-warden http token create --id <name>`) or your organisation's OAuth provider (Microsoft Entra ID, Keycloak). Each token or person only sees the mailboxes you assign. Full guide: [docs/deploy/http.md](docs/deploy/http.md) · Security notes: [docs/security/remote-mode.md](docs/security/remote-mode.md).
## What Claude can do

You decide per mailbox which of four permission levels are active:

| Level | Default | Examples |
|---|---|---|
| **read** | on | search with filters and previews, read messages and whole conversations, attachments |
| **write** | on | mark read, flag, move, sort many messages at once (with preview and confirmation), create reply and forward drafts, manage folders |
| **send** | off | send email or drafts — each send confirmed by you unless you choose otherwise |
| **delete** | off | move to Trash — nothing is ever deleted permanently; you empty the Trash in your own mail program |

## Security at a glance

- **Nothing is changed by guesswork.** If a filter, folder or flag cannot be applied exactly, the
  action fails and says so — it never falls back to "all mail".
- **You approve what leaves your mailbox.** Sending is off by default; when enabled, sends are confirmed,
  limited by recipient rules and rate limits, and recorded.
- **Tamper-evident audit log** of every change and every sent message (no message contents).
- **Encrypted connections only** (TLS 1.2+, no plaintext fallback); self-signed servers are pinned by fingerprint.
- **Prompt-injection screening** of email content before Claude sees it.
- **No telemetry.** See [PRIVACY.md](PRIVACY.md), the [security overview](SECURITY.md) and the
  security documentation in [docs/security/](docs/security/threat-model.md) (threat model, data flow,
  hardening guide, [Sicherheitsübersicht für IT-Verantwortliche](docs/security/sicherheitsuebersicht.md)).

Provider-specific notes (app passwords, Microsoft 365 admin consent and SMTP AUTH, own servers):
[docs/guide/providers.md](docs/guide/providers.md).

## Verify downloads

Every release is built by GitHub Actions from a tagged commit and includes `SHA256SUMS`, a CycloneDX SBOM,
build-provenance attestations, a signed `.mcpb` and an npm package with provenance:

```bash
sha256sum -c SHA256SUMS
gh attestation verify inbox-warden-<version>.mcpb --repo max-achleitner/inbox-warden
node scripts/verify-mcpb.mjs inbox-warden-<version>.mcpb mcpb-signing-cert.pem   # from a checkout of this repository
```

`npx @anthropic-ai/mcpb verify` (2.1.2) reports every bundle as "not signed" because its PKCS#7 check is not
implemented; `scripts/verify-mcpb.mjs` checks the signature with openssl instead
(see [release signing](docs/maintainers/release-signing.md)).

Until an organisation-validated code-signing certificate is available, bundles are signed with a self-signed
certificate ([`mcpb-signing-cert.pem`](mcpb-signing-cert.pem), valid until 17 October 2028). Pin its SHA-256 fingerprint:

```
7E:29:A7:6C:AF:E4:25:A4:F6:03:07:45:C3:76:B0:1E:74:CE:F5:4E:DD:8B:D2:B2:C5:91:13:8B:39:AE:5E:26
```

## Upgrading from a pre-1.0 version

Configuration (`~/.imap-mcp`) and stored passwords carry over. The old start commands
(`node …/dist/index.js`, `imap-mcp-server`, `imap-mcp-setup`) still work until 2.0 and print a
deprecation warning; switch to `inbox-warden serve` / `inbox-warden setup`.
Note: the npm package named `imap-mcp-server` belongs to a different author and is unrelated to this project.

## Support and versions

[Changelog](CHANGELOG.md) · [Support policy](docs/support-policy.md) ·
[Report a problem](https://github.com/max-achleitner/inbox-warden/issues) · Security issues: see [SECURITY.md](SECURITY.md)

## Development

```bash
npm ci
npm run build && npm test          # unit tests, no network
npm run typecheck
docker compose -f test/docker-compose.greenmail.yml up -d
IMAP_IT_HOST=localhost npm run test:integration
npm run build:mcpb && npm run smoke:mcpb
```

## License

MIT
