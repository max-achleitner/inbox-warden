# Security assessment notes: remote (HTTP) mode

Audience: IT/security reviewers. Applies to `inbox-warden serve --http` from version 1.1.0. Local mode (stdio) is unaffected and remains the recommended default.

## Data flow

Client (claude.ai, Claude Code, Agent SDK) → HTTPS (Caddy, TLS 1.2+) → Inbox Warden container → IMAPS/SMTPS → mail servers. Message content passes through memory only; it is sent to the calling client and from there to the LLM provider (Anthropic). Stored on the server: configuration (no secrets), audit log (metadata), encrypted OAuth refresh tokens for mailboxes.

## Authentication and authorisation

| Mode | Who | Mechanism |
|---|---|---|
| Bearer | Claude Code, Agent SDK, routines | 256-bit random tokens; only SHA-256 stored; constant-time check; per-token mailbox mapping; revocation by config change |
| OAuth | People via claude.ai | Organisation IdP (Entra ID / Keycloak); JWT signature via JWKS, issuer, audience, expiry, scope checks; RFC 9728 metadata; per-user/group mailbox mapping; unmatched users → 403 |

Within a mailbox, the account's permission tiers (read/write/send/delete) and the Plan 5 policy (send mode, recipient rules, rate limits, folder scope, bulk caps) apply unchanged. The caller identity is written to the audit log for every tool call.

## Network and runtime hardening

Host-header allowlist (DNS rebinding), Origin check, no CORS, optional source-IP allowlist (e.g. Anthropic `160.79.104.0/21`), proxy-aware client IP (only trusted hops), body limit, header/request timeouts, rate limits per caller and per IP for failed authentication, `Cache-Control: no-store` and restrictive security headers, HSTS. Container: distroless base, uid 65532, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, secrets via Docker secrets only, no OS keychain.

## Refusals by design

- The server does not start in HTTP mode without authentication.
- OAuth mode does not start without explicit caller → mailbox rules.
- Tokens are never logged; configuration files cannot contain plaintext tokens (schema rejects them).
- Tools that would act on the server machine (`sign_in` opens a browser) are not registered in HTTP mode; mailbox OAuth sign-in is done by an administrator with `inbox-warden accounts login <id> --no-browser`.

## Reviewer checklist

- [ ] TLS terminates at Caddy with a valid certificate; port 8787 is not published to the internet.
- [ ] `httpAuth.principals` maps every token/group to the minimum set of mailboxes.
- [ ] Automations use account entries without `send`/`delete`.
- [ ] Entra app: assignment required, Conditional Access (MFA), client secret expiry tracked.
- [ ] `ipAllowlist` decided (Anthropic range + office) or consciously left open.
- [ ] Backups of `/data` and separate storage of the state key.
- [ ] Image and Caddy update process defined (Dependabot / monthly patch window).
