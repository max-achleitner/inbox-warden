---
name: mailbox-cleanup
description: Tidy up the mailbox in bulk — archive old mail, file newsletters, flag what is open. Use when the user asks to clean up, archive, sort or declutter their mailbox or a folder.
---

# Mailbox clean-up

1. To see what fills a folder, call `summarize_senders` (by `address` or `domain`) instead of paging through `search_emails`; use `search_emails` with `compact: true` when you need subjects.
2. Agree on the rule with the user first, in plain words: which folder, which sender or subject, older than which date, and where it should go. Check the destination with `list_folders`; never create folders without asking.
3. Use `organize_by_filter`. Its first call returns a **preview**: number of matching messages, the senders of all of them (`topSenders`), a few examples, and a `confirmToken`.
4. Show the user the count, the senders and the examples. Ask for confirmation. Only then call `organize_by_filter` again with the `confirmToken`. If the count is far higher than the user expected, or `topSenders` shows senders that do not belong, stop and refine the filter instead.
5. Report what was done (count, source, destination). Mention that moved mail can be moved back.

Rules:
- Prefer moving to an archive folder over deleting. Delete only when the user explicitly asks to delete and the delete permission is enabled.
- If the server refuses a filter (for example custom keywords on Microsoft 365), explain it and suggest a folder instead; never retry with a broader filter.
