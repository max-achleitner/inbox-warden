# Security policy

## Supported versions

| Version | Supported |
|---|---|
| Latest minor release (1.x) | Yes — security fixes |
| Previous minor release | Yes, for 3 months after the next minor release |
| Pre-1.0 releases | No — please upgrade |

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub:
https://github.com/max-achleitner/inbox-warden/security/advisories/new

Include, if possible: affected version, configuration (redact secrets), steps to reproduce, impact, and whether the issue is already public.

What happens next:
- Acknowledgement within **3 working days**.
- First assessment (severity, affected versions) within **10 working days**.
- A fix or mitigation for critical and high issues within **30 days**; we coordinate the disclosure date with you and credit you unless you prefer otherwise.

## Scope

In scope: this server, its CLI, the MCPB bundle and the Docker image published from this repository.
Out of scope: the Claude clients, the LLM, mail providers, and third-party MCP servers.

Examples of issues we want to hear about: ways to send, delete or read mail outside the configured permissions and policy; bypasses of folder restrictions or confirmation; credential or message-content leaks into logs or the audit log; audit-log tampering that `audit verify` does not detect; TLS downgrade.

## Safe harbour

We will not take legal action against good-faith research that respects user privacy, uses only your own accounts and test data, and gives us reasonable time to fix the issue before disclosure.
