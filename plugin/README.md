# Inbox Warden — Claude Code plugin

Connects one mailbox to Claude Code through the signed `inbox-warden` extension and adds three skills:
`inbox-triage`, `reply-drafting`, `mailbox-cleanup`.

Install:

    claude plugin marketplace add max-achleitner/inbox-warden
    claude plugin install inbox-warden@achleitner

Then run `/plugin`, open **Installed**, select **Inbox Warden** and choose **Configure**. Only the email address and
the password are required (Gmail, iCloud and Yahoo need an app password).
Defaults: Claude may read and create drafts; sending and moving mail to the Trash are off until you switch them on.

Microsoft 365 or Google Workspace sign-in, several mailboxes, or a self-signed server certificate: use the
command-line version described in the main README instead of this plugin.
