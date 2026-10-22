# Inbox Warden

**Email for Claude — safely.** Let Claude search, read, sort and draft your email in any mailbox
that speaks IMAP/SMTP: Gmail and Google Workspace, Microsoft 365 and Outlook.com (preview), GMX, Web.de, IONOS,
iCloud, Yahoo, or your own mail server.

*Deutsch:* [Benutzerhandbuch](docs/guide/de/README.md) · *English:* [User guide](docs/guide/en/README.md)

## Install — pick the way that fits you

| | Claude Desktop extension | Claude Code plugin | Command line (npm) |
|---|---|---|---|
| Install | drag a file into Settings → Extensions | two commands | `npm install -g` + `setup` |
| Password / app password (Gmail, GMX, IONOS, iCloud, own server …) | ✓ | ✓ | ✓ |
| Microsoft 365 sign-in (preview) | — | — | ✓ |
| Google Workspace sign-in (your organisation's OAuth client) | — | — | ✓ |
| Several mailboxes in one installation | — | — | ✓ |
| Own server with a self-signed certificate (pinned) | — | — | ✓ |
| Needs Node.js on the computer | no | no | yes (20.19+) |

**Microsoft 365 and Outlook.com are a preview.** Inbox Warden does not ship its own Microsoft app yet, so your
administrator registers one once ([steps](docs/guide/providers.md#microsoft-365--exchange-online--for-the-administrator)),
and the Microsoft sign-in has not yet been tested against a real Microsoft 365 tenant.

### Claude Desktop (recommended for most people)

1. Download `inbox-warden-<version>.mcpb` from the [latest release](https://github.com/max-achleitner/inbox-warden/releases/latest).
2. Open Claude Desktop, click your profile (bottom left) → **Settings → Extensions**, drag the file into the field
   there (double-clicking does not work) and click **Install**.
3. Enter your email address and your password; Gmail, Yahoo and iCloud need an
   [app password](docs/guide/en/README.md#app-passwords). Leave the server fields empty; they are detected from your
   address. Microsoft 365 and Google Workspace sign-in is not in this form: use the command-line version
   ([steps](docs/guide/en/README.md#microsoft-365-and-google-workspace)). To change a setting later, open
   Profile → Settings → Extensions → Inbox Warden → **Configure**, save and start a new chat.
4. Start a new chat: *"What's new in my inbox?"*

The extension's password is stored encrypted by Claude Desktop; the command-line version keeps passwords and sign-ins in your operating system's keychain. By default Claude
can read and create drafts, but cannot send or delete — you send drafts from your mail program.

**Team and Enterprise administrators** can upload the bundle once for the whole organisation
(Organization settings → Connectors → Desktop) and allow-list it. Do not set
`isDesktopExtensionSignatureRequired`: with Claude Desktop 3.x it blocks every locally installed extension,
because Desktop cannot confirm any signature. See [Verify downloads](#verify-downloads) and the
[hardening guide](docs/security/hardening-guide.md).

### Claude Code

```bash
claude plugin marketplace add max-achleitner/inbox-warden
claude plugin install inbox-warden@achleitner
```

Then `/plugin` → **Installed** → **Inbox Warden** → **Configure**. The plugin adds skills for inbox triage,
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

What protects your mailbox is what Claude is *allowed* to do, not what an email tells it:

- **Sending and deleting are off by default.** Claude reads, sorts and writes drafts; you send them from
  your mail program. You switch sending or deleting on per mailbox.
- **You approve what leaves your mailbox.** With sending on, each send is confirmed — in Inbox Warden's own dialog where your Claude app can show one, otherwise through the app's approval prompt (unless you choose `direct`); recipient rules and rate limits apply, and every send is recorded. A recipient needs your confirmation when Inbox Warden saw it only inside a received email in this session.
- **Bulk changes are previewed first.** Sorting or deleting many messages at once first shows how many
  are affected, then changes exactly those — at most 500 per action (100 for deletes) by default.
- **Locked folders stay out of reach.** Keep mail under an NDA in a folder Claude can neither see nor open:
  name it in the extension's form or with `inbox-warden accounts edit <id> --lock-folder <folder>`
  ([how](docs/guide/en/README.md#lock-folders-away-from-claude)).
- **Nothing is changed by guesswork.** If a filter, folder or flag cannot be applied exactly, the
  action fails and says so — it never falls back to "all mail".
- **Claude reads what you see.** Text an email hides in its HTML (invisible elements, white on white, tiny fonts) and invisible characters are removed before Claude reads the message.
- **Drafts are yours to check.** Before you send a draft Claude wrote, look at the recipients and the text. Inbox Warden warns when a recipient appears only inside an email Claude read recently ([limits](docs/security/threat-model.md#6-honest-limits)); `policy.untrustedRecipients: "refuse"` blocks such drafts and sends. Remote images are removed from the HTML Claude writes, and its links are listed.
- **Tamper-evident audit log** of every change and every sent message (no message contents).
- **Encrypted connections only** (TLS 1.2+, no plaintext fallback); self-signed servers are pinned by fingerprint.
- **Built for untrusted mail.** Text in an email can try to steer Claude (prompt injection). No filter detects that reliably, so Inbox Warden does not depend on one: what protects you are the permissions and confirmations above and the removal of hidden text. A heuristic check also marks suspicious messages — a hint, not a safeguard.
- **No telemetry.** See [PRIVACY.md](PRIVACY.md), the [security overview](SECURITY.md) and the
  security documentation in [docs/security/](docs/security/threat-model.md) (threat model, data flow,
  hardening guide, [Sicherheitsübersicht für IT-Verantwortliche](docs/security/sicherheitsuebersicht.md)).

Provider-specific notes (app passwords, Microsoft 365 admin consent and SMTP AUTH, own servers):
[docs/guide/providers.md](docs/guide/providers.md).

## Verify downloads

Every release is built by GitHub Actions from a tagged commit and includes `SHA256SUMS`, a CycloneDX SBOM,
build-provenance attestations, an unsigned `.mcpb` and an npm package with provenance.

**1. Build attestation (the main check).** Proves that the file was built by this repository's release
workflow from the tagged commit and has not been changed since. Needs the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify inbox-warden-<version>.mcpb --repo max-achleitner/inbox-warden \
  --signer-workflow max-achleitner/inbox-warden/.github/workflows/release.yml \
  --source-ref refs/tags/v<version>
```

The same command checks `inbox-warden-<version>.tgz`, the file published to npm. Checksums of the files you
downloaded: `sha256sum --ignore-missing -c SHA256SUMS`.

**2. Bundle signature.** 0.6.0 bundles were signed; from 0.7.0 on they are not (see
[release signing](docs/maintainers/release-signing.md)). The attestation and the checksums prove where a bundle
came from.

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
