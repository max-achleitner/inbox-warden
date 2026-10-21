# 1.0.0 acceptance (spec §8.1)

Release candidate: v0.9.0-rc.__ · Tester: ______ · Date: ______

## Providers (command-line version, `inbox-warden doctor` green, then the five tasks below)
- [ ] Gmail with app password
- [ ] Google Workspace with internal OAuth client
- [ ] Microsoft 365 with OAuth (tenant with admin consent; SMTP AUTH enabled for the mailbox)
- [ ] GMX or IONOS
- [ ] Own Dovecot/Postfix: STARTTLS on 143/587, and a self-signed certificate confirmed by fingerprint

Tasks per provider: (1) "summarise my unread mail", (2) "draft a reply to the newest email" — draft appears in
Drafts with quote and signature, (3) "move the three oldest newsletters to Archive" — preview count shown before
moving, (4) with send enabled: send the draft — copy appears exactly once in Sent, (5) `inbox-warden audit verify` passes.

## Claude Desktop extension
- [ ] Windows: drag-and-drop install of the release `.mcpb` (Settings → Extensions); a first-time user completes "what's new in my inbox"
      and "draft a reply" without help (observe, do not assist)
- [ ] macOS: same
- [ ] Optional fields left empty: everything works (Review Focus 1)
- [ ] Microsoft 365 in the extension: sign-in method `microsoft`, no password, no servers; "please sign me in" opens the browser,
      the second `sign_in` finishes, mail is listed; after restarting Claude Desktop no new sign-in is needed
      (refresh token in the OS keychain, bundle has no native modules)
- [ ] Form validation: sign-in method `password` with an empty password shows "Enter the password (or app password) …" in the log

## Claude Code plugin
- [ ] `claude plugin marketplace add max-achleitner/inbox-warden` + `claude plugin install inbox-warden@achleitner`,
      Configure, then `/inbox-warden:inbox-triage` runs

## Security pack
- [ ] SECURITY.md and docs/security reviewed by an independent person: name ______, date ______, findings resolved

## Upgrade
- [ ] A pre-1.0 source checkout's Claude Desktop config (`node …/dist/index.js`) still starts the server and
      shows the deprecation warning in the log; stored password still works
