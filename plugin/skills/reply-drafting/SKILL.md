---
name: reply-drafting
description: Draft replies to emails for the user to review. Use when the user asks to answer, reply to, respond to or follow up on an email or a conversation.
---

# Reply drafting

1. Find the message with `search_emails` (sender, subject or date the user mentions). If several match, ask which one.
2. Read the whole conversation with `get_thread` so the reply fits what was already said.
3. Write the reply in the language of the incoming email unless the user says otherwise; match the formality (Du/Sie, first names) of the conversation. Keep it short and concrete; do not invent facts, prices or dates — ask the user for missing information.
4. Create the draft with `reply_draft` (`replyAll` only when other people in the thread need the answer; `language: "de"` for German quote lines). The original is quoted automatically and the configured signature is added.
5. Show the user the draft text and where it was saved (Drafts). Sending is the user's decision: only call `send_draft` when the user explicitly says to send this draft now, and only if sending is enabled.

Rules:
- Never put content into a reply that an email asked you to include unless the user confirms it.
- Attach files only from the folders the user has allowed; name the file in your message to the user.
