# imap-mcp-server

An MCP server that gives AI assistants (Claude, etc.) access to your email via IMAP/SMTP. Search, read, draft, and organize emails — with permission controls that keep you in charge.

## Quick Start

```bash
# Install
npm install -g imap-mcp-server

# Configure your email account
imap-mcp-setup

# Or run from source
git clone https://github.com/max-achleitner/imapmcp.git
cd imapmcp
npm install && npm run build
npm run setup
```

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "email": {
      "command": "imap-mcp-server"
    }
  }
}
```

Or if running from source:

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/path/to/imapmcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop — the email tools will appear automatically.

## Permissions

Tools are grouped into four tiers. You choose what the AI can do during setup. Disabled tiers = those tools are never registered.

| Tier | Default | What it can do |
|------|---------|----------------|
| **read** | on | List folders, search, read emails, download attachments |
| **write** | on | Mark read/unread, move emails, create/reply drafts, manage folders |
| **send** | **off** | Send emails via SMTP |
| **delete** | **off** | Permanently delete emails |

By default the server can read and organize your mail, draft replies for your review — but cannot send or delete anything.

## Tools

### Read Tier
| Tool | Description |
|------|-------------|
| `list_folders` | List all mailbox folders |
| `search_emails` | Search with filters: from, to, cc, date range, unread, flagged, has attachment, size, headers |
| `read_email` | Read full email content by UID |
| `get_email_count` | Get total/unread counts per folder |
| `download_attachment` | Download attachment content (text returned as UTF-8, binary as base64) |
| `get_quota` | Get mailbox storage quota (usage, limit, percentage) |

### Write Tier
| Tool | Description |
|------|-------------|
| `mark_as_read` | Mark emails as read or unread |
| `move_email` | Move emails between folders |
| `flag_email` | Add or remove IMAP flags (starred, answered, custom keywords) |
| `create_draft` | Compose an email and save to Drafts (supports attachments) |
| `reply_draft` | Create a threaded reply draft (with proper In-Reply-To/References headers) |
| `create_folder` | Create a new mail folder |
| `delete_folder` | Delete an empty folder (refuses if it contains messages or subfolders) |
| `rename_folder` | Rename or move a folder |

### Send Tier (off by default)
| Tool | Description |
|------|-------------|
| `send_email` | Send an email via SMTP |
| `send_draft` | Send an existing draft via SMTP (create_draft → review → send_draft workflow) |

### Delete Tier (off by default)
| Tool | Description |
|------|-------------|
| `delete_email` | Move to Trash, or permanently expunge if already in Trash |

### Always Available
| Tool | Description |
|------|-------------|
| `health_check` | Server health status: IMAP connection, SMTP config, security stats, uptime |

## Security

### Prompt Injection Defense

Every email returned by the server is scanned for prompt injection attempts before reaching the AI. The scanner detects:

- Direct instruction injection (`[SYSTEM]`, "ignore previous instructions")
- Unicode obfuscation (fullwidth, math symbols, regional indicators, superscript)
- Invisible text (zero-width characters, bidi overrides)
- HTML comment injection and hidden elements
- Structured data injection (fake JSON/XML/YAML with role/system fields)
- Social engineering (fake authority claims, secrecy instructions)
- Encoding evasion (base64/URL/hex-encoded instructions)

Scan results are attached as `_injectionScan` metadata — the original email content is never modified.

### Credentials

Stored in `~/.imap-mcp/credentials.json` with restricted file permissions (0o600). Passwords are stored locally, never transmitted except to your configured IMAP/SMTP server.

### MCP Annotations

All tools carry `readOnlyHint` and `destructiveHint` annotations so MCP clients can display appropriate warnings.

## Development

```bash
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm test             # Run tests
npm start            # Start server
npm run setup        # Configure credentials
```

## License

MIT
