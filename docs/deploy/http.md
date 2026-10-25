# Remote mode: Inbox Warden over HTTPS

> **Kurzfassung (Deutsch):** Der Remote-Modus macht Ihre Postfächer für claude.ai (Web/App), Claude Code und geplante Automatisierungen erreichbar, auch wenn Ihr PC aus ist. Er läuft als Docker-Container hinter Caddy (automatisches HTTPS). Zugriff gibt es nur mit einem Token oder mit einer Anmeldung über Ihr eigenes Microsoft-/Keycloak-Konto; jede Person bzw. jedes Token sieht nur die Postfächer, die Sie zuweisen. Für Claude Desktop und Claude Code auf Ihrem eigenen Rechner brauchen Sie den Remote-Modus **nicht**.

## When to use it

| You want | Use |
|---|---|
| Claude Desktop or Claude Code on your own computer | Local mode (MCPB bundle or `npx inbox-warden`), not this guide |
| claude.ai in the browser or the Claude mobile app | Remote mode with OAuth (section 4) |
| Colleagues sharing one server, each seeing only their mailbox | Remote mode with OAuth + `principals` |
| Scheduled runs (Claude Code routines, Agent SDK jobs) while your PC is off | Remote mode with bearer tokens (section 3) |

## 1. Architecture

```
Claude (claude.ai / Claude Code / Agent SDK)
        │ HTTPS  (Authorization: Bearer …)
        ▼
Caddy :443  ── TLS certificates (Let's Encrypt), X-Forwarded-For
        │ http, internal Docker network
        ▼
inbox-warden :8787  (read-only container, uid 65532)
  Host/Origin check → IP allowlist → token check → mailbox mapping → rate limit → MCP tools
        │ IMAPS / SMTPS
        ▼
Your mail servers
```

The server keeps no email content. `/data` holds the audit log and, if you use OAuth for mailboxes, the encrypted refresh tokens.

## 2. Prepare the host

1. A small Linux VM (1 vCPU, 1 GB RAM) with Docker Engine 24+ and the compose plugin.
2. A DNS name such as `mail.example.com` pointing at the VM; inbound TCP 80 and 443 open (Caddy needs 80 for the certificate challenge); outbound IMAP/SMTP ports open.
3. Copy the repository (or only `Dockerfile`, `package*.json`, `tsconfig.json`, `src/`, `deploy/`) to the VM.
4. Create the configuration and secrets:

```bash
cd deploy
mkdir -p config secrets
cp config.example.json config/config.json        # then edit: accounts, publicUrl, principals
printf '%s' 'the-mailbox-password' > secrets/office_password.txt
openssl rand -base64 32 > secrets/state_key.txt
chmod 600 secrets/*
```

5. Replace `mail.example.com` in `Caddyfile` and in `config/config.json` (`http.publicUrl`).

Secrets are passed as Docker secrets (`*_FILE` variables), never baked into the image or the config file. Password variable names follow the account id: account `office-readonly` → `IMAP_MCP_PASSWORD_OFFICE_READONLY_FILE`.

The image's entry point is `node dist/bin.js`, so `docker compose run --rm mcp <command> …` runs exactly `inbox-warden <command> …` inside the container, with the container's secret store (environment, Docker secrets and the encrypted state file — never an OS keychain).

### 2.1 Attachment folders (optional)

`files.attachmentDirs` (folders whose files Claude may attach to drafts) and `files.downloadDir` (where `save_attachment` stores attachments) are paths **inside the container**. Mount the host folders and use the container paths in the configuration — the root filesystem is read-only, so only mounted folders can be written:

```yaml
    volumes:
      - ./config:/config:ro
      - mcp-data:/data
      - /srv/firma/angebote:/files/angebote:ro
      - /srv/firma/eingang:/files/eingang
```

```json
"files": { "attachmentDirs": ["/files/angebote"], "downloadDir": "/files/eingang" }
```

`save_attachment` stays available in remote mode (write tier): it writes into the mounted download folder **on the server**, not onto the caller's computer, with the same sandbox rules as locally (no path traversal, blocked executable and macro types, no overwriting). The container runs as uid 65532, so give that user write access: `sudo chown 65532:65532 /srv/firma/eingang`. You can also set `IMAP_MCP_ATTACHMENT_DIRS` and `IMAP_MCP_DOWNLOAD_DIR`; with a config file they replace its `files` folders. `IMAP_MCP_MAX_PERMISSIONS` (e.g. `read,write`) caps the permissions of every mailbox, and `IMAP_MCP_DENY_FOLDERS` adds locked folders to every mailbox.

Keep the download folder outside the attachment folders when tokens or users are limited to different mailboxes: otherwise an attachment saved from one mailbox can be attached to mail sent from another. `serve --http` warns about this overlap.

## 3. Bearer tokens (Claude Code, Agent SDK, routines)

Create one token per client so you can revoke them separately. The config file is mounted read-only, so print the entry and paste it:

```bash
docker compose run --rm mcp http token create --id laptop --print-only
```

The output shows the token **once** (`imcp_…`) and a JSON entry `{"id":"laptop","sha256":"…"}`. Add the entry to `httpAuth.tokens` in `config/config.json`, map it to mailboxes in `httpAuth.principals`, then start the stack:

```bash
docker compose up -d --build
docker compose ps        # mcp: healthy, caddy: running
curl -s https://mail.example.com/healthz   # {"status":"ok"}
```

**Claude Code:**

```bash
claude mcp add --transport http mail https://mail.example.com/mcp --header "Authorization: Bearer imcp_…"
```

**Claude Agent SDK (TypeScript):**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Summarise today's unread mail in the office mailbox.",
  options: {
    mcpServers: {
      mail: {
        type: "http",
        url: "https://mail.example.com/mcp",
        headers: { Authorization: `Bearer ${process.env.MAIL_MCP_TOKEN}` },
      },
    },
    allowedTools: ["mcp__mail__search_emails", "mcp__mail__read_email"],
  },
})) {
  if (message.type === "result" && message.subtype === "success") console.log(message.result);
}
```

**Scheduled runs:** give each automation its own token and map it to an account entry with reduced permissions — `config.example.json` contains `office-readonly`, the same mailbox with only the `read` tier. A routine that only summarises can then never move, send or delete.

Store tokens like passwords (password manager, CI secret store). Rotate: `http token create` a new one, update the client, then `http token revoke --id <old>` — for a read-only config remove the entry by hand — and `docker compose restart mcp`.

## 4. OAuth with Microsoft Entra ID (claude.ai custom connector)

claude.ai connects with OAuth 2.1 + PKCE. The server is an OAuth *resource server*: Entra ID signs people in, the server checks the access token and maps the person to mailboxes. Entra ID does not support dynamic client registration, so you register one app and enter its client id/secret in claude.ai.

### 4.1 App registration

In the Entra admin center → **App registrations → New registration**:

1. Name `inbox-warden`, *Accounts in this organizational directory only*.
2. **Expose an API → Application ID URI**: set it to exactly your MCP URL, `https://mail.example.com/mcp`. Claude sends this URL as the RFC 8707 `resource` parameter; Entra rejects the sign-in (`AADSTS9010010`) when the resource and the scope's Application ID URI differ. Entra only accepts `https://` Application ID URIs on a domain verified in your tenant (**Custom domain names**).
3. **Expose an API → Add a scope**: name `mail.access`, *Admins and users*, display name "Use mailboxes through Inbox Warden".
4. **Manifest**: set `"requestedAccessTokenVersion": 2` (under `api`). Tokens then have issuer `https://login.microsoftonline.com/<tenant-id>/v2.0` and `aud` = the application (client) id.
5. **Authentication → Add a platform → Web**, redirect URI `https://claude.ai/api/mcp/auth_callback`.
6. **Certificates & secrets → New client secret** (6–12 months; put the expiry in your calendar).
7. **Token configuration → Add groups claim** (Security groups, "Group ID") if you map by group; for `email` rules add the optional access-token claim `upn` (or `email` together with `xms_edov`).
8. **Enterprise applications → inbox-warden → Properties → Assignment required: Yes**, then assign the users/groups who may use it. Add a Conditional Access policy (MFA) for the app.

### 4.2 Server configuration

```json
"http": { "host": "0.0.0.0", "port": 8787, "publicUrl": "https://mail.example.com", "trustProxy": 1, "ipAllowlist": ["160.79.104.0/21"] },
"httpAuth": {
  "mode": "oauth",
  "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
  "audience": ["<application-client-id>", "https://mail.example.com/mcp"],
  "requiredScopes": ["mail.access"],
  "scopesSupported": ["https://mail.example.com/mcp/mail.access", "offline_access"],
  "principals": [
    { "match": { "group": "<object-id-of-group-Office>" }, "accounts": ["office"] },
    { "match": { "email": "max@example.com" }, "accounts": ["*"] }
  ]
}
```

- `requiredScopes` uses the short name Entra writes into the `scp` claim; `scopesSupported` is what clients request (full Application ID URI form) and is published at `https://mail.example.com/.well-known/oauth-protected-resource/mcp`.
- `ipAllowlist` with `160.79.104.0/21` admits only Anthropic's outbound range (claude.ai). Add your office range if colleagues also use Claude Code directly. Leave it empty if you do not want an IP restriction.
- OAuth mode requires `principals`; someone who signs in successfully but matches no rule gets HTTP 403 and sees no mailbox.
- An `email` rule only matches an address the identity provider vouches for: `email` with `email_verified: true` (OIDC, e.g. Google, Keycloak) or Entra's `xms_edov`, or else Entra's tenant-assigned `upn` (guest accounts with `#EXT#` never match). `preferred_username` and unverified `email` claims are ignored because users or guests can set them. Prefer `group` rules where you can.

Restart: `docker compose up -d`.

### 4.3 Add the connector in claude.ai

**Settings → Connectors → Add custom connector**: name `Mail`, URL `https://mail.example.com/mcp`, **Advanced settings**: OAuth Client ID = the application id, OAuth Client Secret = the secret from 4.1 step 6 → **Add** → **Connect** → Microsoft sign-in. On Team/Enterprise plans an Owner adds the connector once for the organisation (Organization settings → Connectors).

## 5. Other identity providers

- **Keycloak / Authentik / Zitadel** (recommended broker, also for Google Workspace logins): create a confidential client for claude.ai (standard flow, PKCE S256, redirect `https://claude.ai/api/mcp/auth_callback`), add an *audience* mapper with `https://mail.example.com/mcp`, add a client scope `mail.access` that is included in the access token `scope` claim. Config: `"issuer": "https://idp.example.com/realms/kmu"`, `"audience": "https://mail.example.com/mcp"`, `"requiredScopes": ["mail.access"]`. Keycloak supports dynamic client registration, so claude.ai can also register itself if you allow it in the realm's client registration policies.
- **Google directly** is not supported: Google's access tokens for third-party APIs are opaque, not JWTs. Use Google as a login provider inside Keycloak/Authentik instead.
- The server discovers signing keys from `<issuer>/.well-known/openid-configuration` (then RFC 8414). Set `httpAuth.jwksUri` if your IdP publishes keys elsewhere.

## 6. Mailboxes that use OAuth (Microsoft 365, Google Workspace) inside the container

In local mode Claude can start a mailbox sign-in with the `sign_in` tool, which opens a browser on the computer running the server. In remote mode that computer is the server, so **`sign_in` is never offered over HTTP** — an administrator signs each OAuth mailbox in once from the command line instead, with `inbox-warden accounts login <id> --no-browser --listen-host 0.0.0.0 --port 53682` run inside the container (the image runs it as `node dist/bin.js accounts login …`):

```bash
docker compose run --rm -p 127.0.0.1:53682:53682 mcp accounts login office --no-browser --listen-host 0.0.0.0 --port 53682
```

`--no-browser` prints the sign-in URL instead of opening a browser. Open it in your browser on the machine where you ran the command; the sign-in returns to `http://localhost:53682`, which the published port forwards into the container (bound to `127.0.0.1` only, so nobody else can reach it). The command saves the refresh token and exits.

The token goes into the encrypted file `/data/secrets.enc.json` (key: `IMAP_MCP_STATE_KEY_FILE`); without a state key the command refuses to store it. Rotated refresh tokens are written back to the same file automatically. Repeat the command when a mailbox needs a new sign-in (password change, revoked consent) — Claude will report the mailbox as signed out until then.

## 7. Operations

| Task | How |
|---|---|
| Logs | `docker compose logs -f mcp` (JSON lines on stderr; no tokens, no mail content) |
| Health | `GET /healthz` → `{"status":"ok"}`; Docker health status in `docker compose ps` |
| Audit trail | `/data/audit/` in volume `mcp-data`; every call carries `principal` (`token:<id>` or `oauth:<sub>`) |
| Backup | Volume `mcp-data` (audit, encrypted tokens), `config/config.json`; keep `secrets/state_key.txt` in a separate, safe place — without it the token file cannot be decrypted |
| Upgrade | Pull/rebuild the new version, `docker compose up -d`; roll back by starting the previous image tag. Read the release notes for config changes first. |
| Revoke access | Bearer: remove the token entry, restart. OAuth: remove the user from the Entra app assignment or the mapped group. |
| Rate limits | `http.rateLimit.perMinute` / `burst` per caller (default 120/min, burst 30); `authFailuresPerMinute` per client IP (default 30) |

## 8. Security notes for remote mode

Remote mode changes the exposure: the endpoint is reachable over the network, and anyone holding a valid token, or an IdP account matched by `principals`, can use the mapped mailboxes within the permissions of those accounts.

Controls in place:

- No unauthenticated start: `serve --http` exits with code 2 without `httpAuth`, even on loopback.
- Bearer tokens: 256-bit random, only SHA-256 hashes stored, constant-time comparison, one token per client, revocable.
- OAuth: signature (JWKS), issuer, audience, expiry and scopes checked; `none`/symmetric algorithms rejected; tokens for other APIs (e.g. Microsoft Graph) rejected; unmatched users get 403.
- Per-caller mailbox scoping; other mailboxes are invisible — asking for one gets the same "There is no mail account …" answer as a non-existent account, listing only the caller's own mailboxes.
- Tools that act on the server machine (`sign_in`, which opens a browser) are never offered over HTTP; mailbox sign-in is an administrator task (section 6).
- DNS-rebinding protection (Host allowlist), browser Origin check, no CORS, optional IP allowlist, proxy-aware client IPs, body size limit (default 4 MiB), request and header timeouts, per-caller and per-IP rate limits, security headers.
- Container: distroless, non-root, read-only root filesystem, all capabilities dropped, no keychain, secrets only via Docker secrets/env and an AES-GCM state file.
- Audit trail with the caller identity for every tool call (Plan 5).

Residual risks and what to do:

- **Stolen bearer token** = access to the mapped mailboxes until revoked → one token per client, least-privilege account entries, rotate quarterly, prefer OAuth for people.
- **Compromised IdP account** → MFA/Conditional Access, assignment required, short sessions.
- **Internet exposure / DoS** → keep Caddy and the image updated, consider the IP allowlist, monitor 401/429 spikes in the logs.
- **Anthropic changes its egress range** → re-check https://claude.com/docs/connectors/custom/add-unlisted if claude.ai suddenly gets 403.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error: HTTP mode requires "httpAuth"` and exit code 2 | No `httpAuth` section | Section 3 or 4 |
| 403 `Invalid Host` | Request host is not `publicUrl`/`allowedHosts` | Set `http.publicUrl` to the name clients use |
| 403 `No mailbox is assigned to this identity` | No `principals` rule matches | Check the token id / group object id / email in the rule |
| claude.ai sign-in fails with `AADSTS9010010` | Application ID URI ≠ MCP URL | Section 4.1 step 2 |
| claude.ai loops back to sign-in | Token audience or scope rejected | `audience` must contain the application id; `requiredScopes` uses the short scope name |
| 429 with `Retry-After` | Rate limit | Raise `http.rateLimit` or slow the automation |
| 503 `temporarily_unavailable` | IdP keys not reachable | Outbound HTTPS to the IdP; set `httpAuth.jwksUri` |
