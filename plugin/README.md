# Inbox Warden — Claude Code plugin

Connects one mailbox to Claude Code through the signed `inbox-warden` extension and adds three skills:
`inbox-triage`, `reply-drafting`, `mailbox-cleanup`.

Install:

    claude plugin marketplace add max-achleitner/inbox-warden
    claude plugin install inbox-warden@achleitner

Then run `/plugin`, select **inbox-warden** → **Configure**, and enter your email address and either
your (app) password or the sign-in method `microsoft` (Microsoft 365, preview) / `google` plus the OAuth client ID
from your administrator (then ask Claude "please sign me in").
Defaults: Claude may read and create drafts; sending and deleting are off.

Several mailboxes or a self-signed server certificate: use the command-line installation described in the
main README instead of this plugin.
