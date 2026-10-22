# Hardening guide

Recommended settings for companies. Start with the baseline, then pick a profile per mailbox.

## 1. Baseline configuration

```json
{
  "version": 2,
  "accounts": [
    {
      "id": "office",
      "email": "office@example-company.at",
      "imap": { "host": "mail.example-company.at", "port": 993 },
      "smtp": { "host": "mail.example-company.at", "port": 465 },
      "permissions": { "read": true, "write": true, "send": false, "delete": false },
      "policy": {
        "send": {
          "mode": "drafts-only",
          "blockedRecipientDomains": [],
          "maxRecipients": 10,
          "maxPerHour": 10,
          "maxPerDay": 50,
          "confirmAfterInjectionRisk": "high"
        },
        "bulk": { "maxMessages": 200, "maxDelete": 50 },
        "folders": { "deny": ["**/HR/**", "**/Personal/**", "**/Geschäftsführung/**"] },
        "protectedFolders": true,
        "attachments": { "maxDownloadBytes": 10485760, "blockExecutables": true }
      }
    }
  ],
  "audit": { "enabled": true, "level": "standard", "retentionDays": 365 }
}
```

Every policy setting is checked strictly: a misspelt key stops the server with an error instead of being ignored.

`policy.folders` locks folders away from the AI in every tool. A hidden folder is not listed, counted, searched or read. Mail cannot be moved into or out of it, flagged or deleted there, and replies or forwards of its mail cannot be drafted. The folder cannot be renamed or deleted, and no folder can be created in it or renamed into it. Every refusal says that nothing was changed. Patterns are case-insensitive globs (`*` within one level, `**` across levels).

- **Deny covers subfolders, and a name covers every depth.** `"deny": ["_NDA_Inbox"]` hides `_NDA_Inbox` and every folder below it (`_NDA_Inbox/Projekt`, `_NDA_Inbox/Projekt/2026`). A pattern without `/` is a folder name and matches at any depth, so it also hides `Projekte/_NDA_Inbox`; `_NDA_*` hides every folder whose name starts with `_NDA_`, wherever it is. A leading `/` limits a name to the top level (`/Archiv`). A pattern with `/` is a path from the top level (or from below the `INBOX.` prefix, see below): `Projekte/_NDA_Inbox` does not hide `Archiv/Projekte/_NDA_Inbox`. Deny wins over allow.
- **Allow does not cover subfolders.** With `allow`, only the folders a pattern matches are visible, and an allowed folder does not open the folders below it. Write `Archiv/**` for a folder and everything below it.
- **The separator and the `INBOX.` prefix do not matter.** Patterns use `/` whatever the server uses: write `INBOX/HR`, not `INBOX.HR`. Some servers (Dovecot, Courier, Cyrus) keep every folder below INBOX (`INBOX.Kunden`). Patterns match with and without that leading `INBOX/`, so `_NDA_Inbox` also hides `INBOX._NDA_Inbox`. A deny pattern written with the prefix works on both kinds of server too: `INBOX/_NDA_Inbox` also hides a top-level `_NDA_Inbox` (unless a wildcard follows the prefix, as in `INBOX/*`). Allow patterns written with the prefix match only below INBOX, so write allow patterns without it. Two side effects: on a server where INBOX has real subfolders, `HR` also hides `INBOX/HR`; and denying `INBOX` hides every folder below it, which on the servers above means every folder.
- **Rules match names.** Renaming a locked folder in the mail program or on the server unlocks it, with all its mail, under its new name, and a server rule that still files into the old name may then deliver to INBOX instead. Check `policy.folders` and the server rules after every folder rename. The AI itself cannot rename a locked folder.
- **File locked mail on the server.** To keep mail such as NDA correspondence away from the AI entirely, let a server-side rule (Sieve, Exchange transport or inbox rule, Gmail filter with "Skip the Inbox") move it into the locked folder on delivery. A rule in the desktop mail program runs only while the program is open, so the mail sits in INBOX, visible to the AI, until then.

`allowedRecipientDomains` always lets the mailbox's own domains through. For a mailbox at a public provider (gmail.com, gmx.de, outlook.com) that means every address at that provider, so use it with company domains.

As soon as `policy.folders` hides any folder, folders that show the mail of all other folders are hidden too, whatever their name: Gmail's All Mail, Starred and Important (listed by the server as `\All`, `\Flagged`, `\Important`).

**Gmail labels.** On Gmail every folder is a label, and one message can carry several: an NDA mail labelled `_NDA_Inbox` can also sit in INBOX, carry `Kunden` or be your reply in Sent. A message with a label that a `deny` pattern hides is hidden in every folder, as if it did not exist: no tool lists, counts, reads, changes, replies to or forwards it, and a UID pointing at it is answered like a missing one. Labels follow the deny rules above; `\Inbox`, `\Sent`, `\Draft`, `\Trash` and `\Spam` count as INBOX and the matching special folder, `\Important` and `\Starred` never hide a message, and a label merely missing from `allow` hides nothing. If Gmail does not report a message's labels, the tool refuses and changes nothing. On such an account `get_email_count` reads the labels of every message instead of the folder status (up to 20,000 per call; a bigger folder is reported as unavailable), searches check the newest 20,000 matches, `delete_folder` does not say how many messages a non-empty folder holds, and `rename_folder` refuses a folder that holds hidden messages, since renaming a label renames it on them too. Other servers and Gmail accounts without `deny` patterns are not affected.

`policy.untrustedRecipients` (default `warn`) covers recipients that appear only inside a received email and were never written to: `warn` reports them on drafts, `refuse` blocks such drafts. Addresses on the mailbox's own domain are not reported, but public providers such as gmail.com never count as own. Use `refuse` for mailboxes that write only to known contacts.

## 2. Profiles

| Profile | Use for | Settings |
|---|---|---|
| **Read & draft** (recommended default) | Most staff, shared mailboxes | `send: false` or `policy.send.mode: "drafts-only"`; delete off; people send from their mail program |
| **Confirmed sending** | Sales/support staff who want the AI to send | `permissions.send: true`, `policy.send.mode: "confirm"`, `requireElicitation: true` if all staff use clients with confirmation dialogs (Claude Code), `allowedRecipientDomains` with your own and your customers' domains |
| **Automation** (HTTP mode, Plan 7) | Scheduled jobs | Dedicated mailbox, `allowedRecipientDomains` limited to internal domains, low `maxPerDay`, audit level `standard` |

## 3. Claude client settings (Team / Enterprise)

- Use a **Team or Enterprise** plan for business data (admin controls, data processing agreement).
- **Desktop extensions:** enable the extension allowlist and upload the `.mcpb` bundle org-wide (Organization settings → Connectors → Desktop). Turn off installs from the public directory if you do not need them.
- **Do not require signed extensions:** leave `isDesktopExtensionSignatureRequired` unset. With Claude Desktop 3.x it blocks every locally installed extension, because Desktop cannot confirm any signature; bundles from 0.7.0 on are unsigned. Check downloads with the build attestation and `SHA256SUMS` instead.
- **Disable persistent "Always allow":** set `mcpPersistentAlwaysAllowEnabled` to `false`, so users approve sending and deleting each time.
- **Local developer servers:** set `isLocalDevMcpEnabled` to `false` on staff machines that should only run approved extensions.
- These policies are set via MDM on macOS (domain `com.anthropic.claudefordesktop`) or via the Windows policy registry; see Anthropic's admin documentation: https://support.claude.com/en/articles/12622667 (verify key names against the current article before rollout).

## 4. Mail server and provider

- Use **app passwords** (Gmail, iCloud, Yahoo, GMX/Web.de) or **OAuth** (Microsoft 365, Google Workspace) — never the main account password where an alternative exists. Revoke the app password or OAuth grant to cut off access immediately.
- Microsoft 365: enable SMTP AUTH only for the mailboxes that use the send tier.
- Enable server-side sending limits and outbound spam filtering at the provider.
- Self-hosted servers: use a certificate from a public CA, or pin the self-signed certificate during setup. Disable plaintext IMAP (143 without STARTTLS) on the server.

## 5. The device

- Full-disk encryption, screen lock, current OS updates.
- Only one person uses the OS account that runs the server.
- In conversations that read mail, do not let Claude use web fetch, a browser or other internet tools without asking you: a manipulated email could make Claude send data through them, and Inbox Warden never sees that.
- Keep `files.downloadDir` outside folders that coding agents work in; a saved attachment is content from a stranger.
- Keep `IMAP_MCP_PROTOCOL_LOG` unset; enable it only for troubleshooting and delete the log afterwards (it can contain message data).
- Bundle and env-only installations: fill in the IMAP/SMTP server fields or set `IMAP_MCP_NO_AUTOCONFIG=1`; otherwise the server looks up the email domain at every start (DNS MX, `autoconfig.<domain>`, `autoconfig.thunderbird.net`).

## 6. Operations

- **Verify the audit log** monthly and after incidents: `inbox-warden audit verify` (exit code 1 when records were changed or removed). Store the printed head hash somewhere else (ticket, password manager); a later verification that ends at an older hash reveals deleted records.
- **Review** `denied` outcomes and injection findings in the audit log; repeated denials show the AI being steered.
- **Update** with every security release (see `SECURITY.md`); check downloads against the build attestation and `SHA256SUMS`.
- **Incident response:** (1) revoke the app password/OAuth grant, (2) run `inbox-warden audit verify`, (3) review the audit log and the Sent folder for the time window, (4) report to the data protection officer if personal data left the company.

## 7. Checklist for approval

- [ ] Commercial Claude plan with DPA
- [ ] Bundle distributed via the org allowlist; origin checked against the build attestation and `SHA256SUMS`
- [ ] Persistent "Always allow" disabled
- [ ] Send tier off or `drafts-only` for general staff; `confirm` with domain allowlist where enabled
- [ ] Delete tier off
- [ ] Sensitive folders in `policy.folders.deny`
- [ ] Audit enabled, retention matches company policy, monthly `inbox-warden audit verify`
- [ ] App passwords / OAuth instead of main passwords
- [ ] Threat model (`threat-model.md`) and data flow (`data-flow.md`) reviewed
