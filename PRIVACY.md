# Privacy notice — Inbox Warden

*Last updated: 2026-10-14*

Inbox Warden is software that runs on your own computer (or on your own server, if you host the HTTP version). It is not a service: the author does not operate servers for it and receives no data from it.

## What the software accesses

- **Your mailbox**, through the IMAP and SMTP servers you configure, with the permissions you grant (read, write, send, delete).
- **Your credentials**: a password or app password is stored encrypted by Claude Desktop (extension) or in your operating system's keychain (command-line version). Microsoft 365 and Google Workspace sign-ins store a refresh token in the operating system's keychain.
- **Files** only in folders you explicitly allow for attachments.

## Network connections

- Your IMAP and SMTP servers.
- Microsoft's or Google's sign-in endpoints, only when you use that sign-in method.
- **Server detection**, only when the server fields are empty: a DNS lookup of your domain's mail servers and requests to `autoconfig.<your domain>` and Mozilla's `autoconfig.thunderbird.net`. These see your email domain, never your password or your mail. Turn on "Advanced: don't look up servers online" (or set `IMAP_MCP_NO_AUTOCONFIG=1`) and enter the servers yourself to avoid them.

## Where email content goes

When Claude uses a tool, the requested email content (for example a search result or a message body) is passed to the AI application you are using — for Claude, that is Anthropic. Anthropic's handling of that data is governed by your agreement with Anthropic (see https://www.anthropic.com/legal). Inbox Warden itself sends email content nowhere else.

## What is stored locally

- Configuration (`~/.imap-mcp/config.json`, no passwords).
- An audit log of actions that change or send mail (time, account, action, folder, message IDs, recipients). It contains no message bodies or attachments.
- Rate-limit counters.

## What is never collected

No telemetry, no usage statistics, no crash reports, no tracking.

## Contact

Questions: open an issue at https://github.com/max-achleitner/inbox-warden/issues.

---

**Kurzfassung (Deutsch):** Inbox Warden läuft auf Ihrem eigenen Rechner. Der Autor betreibt keine Server und erhält keine Daten. Die Software greift mit den von Ihnen erteilten Rechten auf Ihr Postfach zu. E-Mail-Inhalte, die Claude abruft, gehen an die genutzte KI-Anwendung (bei Claude: Anthropic). Sind die Serverfelder leer, wird Ihre Maildomain (nie das Passwort) per DNS und bei Mozillas Autoconfig-Dienst nachgeschlagen; das lässt sich abschalten. Lokal gespeichert werden nur Konfiguration, ein Prüfprotokoll ohne Nachrichteninhalte und Zähler für Versandlimits. Keine Telemetrie.
