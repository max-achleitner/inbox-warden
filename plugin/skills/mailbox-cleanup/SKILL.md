---
name: mailbox-cleanup
description: Tidy up the mailbox in bulk — archive old mail, file newsletters, flag what is open. Use when the user asks to clean up, archive, sort or declutter their mailbox or a folder.
---

# Mailbox clean-up

1. Agree on the rule with the user first, in plain words: which folder, which sender or subject, older than which date, and where it should go. Check the destination with `list_folders`; never create folders without asking.
2. Use `organize_by_filter`. Its first call returns a **preview**: number of matching messages, a few examples, and a `confirmToken`.
3. Show the user the count and the examples. Ask for confirmation. Only then call `organize_by_filter` again with the `confirmToken`. If the count is far higher than the user expected, stop and refine the filter instead.
4. Report what was done (count, source, destination). Mention that moved mail can be moved back.

Rules:
- Prefer moving to an archive folder over deleting. Delete only when the user explicitly asks to delete and the delete permission is enabled.
- If the server refuses a filter (for example custom keywords on Microsoft 365), explain it and suggest a folder instead; never retry with a broader filter.
