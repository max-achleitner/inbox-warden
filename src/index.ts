import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ImapFlow } from "imapflow";
import { loadCredentials, getPermissions } from "./credentials.js";
import { createImapClient } from "./imap-client.js";
import { createSmtpTransport } from "./smtp-client.js";

// Read tier
import * as listFolders from "./tools/list-folders.js";
import * as searchEmails from "./tools/search-emails.js";
import * as readEmail from "./tools/read-email.js";
import * as getEmailCount from "./tools/get-email-count.js";
import * as downloadAttachment from "./tools/download-attachment.js";

// Write tier
import * as markAsRead from "./tools/mark-as-read.js";
import * as moveEmail from "./tools/move-email.js";
import * as createDraft from "./tools/create-draft.js";
import * as replyDraft from "./tools/reply-draft.js";
import * as manageFolders from "./tools/manage-folders.js";

// Send tier
import * as sendEmail from "./tools/send-email.js";

// Delete tier
import * as deleteEmail from "./tools/delete-email.js";

async function main() {
  const creds = loadCredentials();
  const perms = getPermissions(creds);

  // Log active permissions
  const active = Object.entries(perms)
    .filter(([, v]) => v)
    .map(([k]) => k);
  console.error(`[MCP] Permissions: ${active.join(", ")}`);

  // Lazy IMAP connection — connects on first tool use, with mutex to prevent races
  let imapClient: ImapFlow | null = null;
  let connecting: Promise<ImapFlow> | null = null;
  async function getClient(): Promise<ImapFlow> {
    if (imapClient && imapClient.usable !== false) {
      return imapClient;
    }
    if (!connecting) {
      connecting = createImapClient(creds).then((client) => {
        imapClient = client;
        connecting = null;
        return client;
      }).catch((err) => {
        connecting = null;
        throw err;
      });
    }
    return connecting;
  }

  const server = new McpServer({
    name: "imap-mcp-server",
    version: "1.0.0",
  });

  // Read tier (default: on)
  if (perms.read) {
    listFolders.register(server, getClient);
    searchEmails.register(server, getClient);
    readEmail.register(server, getClient);
    getEmailCount.register(server, getClient);
    downloadAttachment.register(server, getClient);
  }

  // Write tier (default: on)
  if (perms.write) {
    markAsRead.register(server, getClient);
    moveEmail.register(server, getClient);
    createDraft.register(server, getClient, creds.user);
    replyDraft.register(server, getClient, creds.user);
    manageFolders.registerCreate(server, getClient);
    manageFolders.registerDelete(server, getClient);
    manageFolders.registerRename(server, getClient);
  }

  // Send tier (default: off)
  if (perms.send) {
    const smtpTransport = createSmtpTransport(creds);
    sendEmail.register(server, smtpTransport, creds.user);
  }

  // Delete tier (default: off)
  if (perms.delete) {
    deleteEmail.register(server, getClient);
  }

  // Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] IMAP MCP Server running on stdio");

  // Cleanup on exit
  process.on("SIGINT", async () => {
    if (imapClient) await imapClient.logout();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
