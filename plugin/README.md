# Inbox Warden — Claude Code plugin

Connects your mailbox, or every mailbox set up with the command-line version, to Claude Code through the
`inbox-warden` extension and adds three skills:
`inbox-triage`, `reply-drafting`, `mailbox-cleanup`.

Install:

    claude plugin marketplace add max-achleitner/inbox-warden
    claude plugin install inbox-warden@achleitner

Then run `/plugin`, open **Installed**, select **Inbox Warden** and choose **Configure**. Only the email address and
the password are required (Gmail, iCloud and Yahoo need an app password).
Defaults: Claude may read and create drafts; sending and moving mail to the Trash are off until you switch them on.

Several mailboxes, Microsoft 365 or Google Workspace sign-in, or a self-signed server certificate: set them up with
the command-line version described in the main README (`inbox-warden setup`), then leave the email address empty
in **Configure**. The two switches are then an upper limit for every mailbox, and the locked folders apply to every
mailbox.
