#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCredentials, getPermissions } from "./credentials.js";
import { ImapConnectionManager } from "./imap-client.js";
import { createSmtpTransport } from "./smtp-client.js";
import * as log from "./logging/logger.js";

// Read tier
import * as listFolders from "./tools/list-folders.js";
import * as searchEmails from "./tools/search-emails.js";
import * as readEmail from "./tools/read-email.js";
import * as getEmailCount from "./tools/get-email-count.js";
import * as downloadAttachment from "./tools/download-attachment.js";
import * as getQuota from "./tools/get-quota.js";

// Write tier
import * as markAsRead from "./tools/mark-as-read.js";
import * as moveEmail from "./tools/move-email.js";
import * as flagEmail from "./tools/flag-email.js";
import * as createDraft from "./tools/create-draft.js";
import * as replyDraft from "./tools/reply-draft.js";
import * as manageFolders from "./tools/manage-folders.js";

// Send tier
import * as sendEmail from "./tools/send-email.js";
import * as sendDraft from "./tools/send-draft.js";

// Delete tier
import * as deleteEmail from "./tools/delete-email.js";

// Health
import * as healthCheck from "./tools/health-check.js";

const VERSION = "0.1.0";

async function main() {
  log.initLogger();

  const creds = await loadCredentials();
  const perms = getPermissions(creds);

  const active = Object.entries(perms)
    .filter(([, v]) => v)
    .map(([k]) => k);
  log.info("server.starting", { permissions: active, version: VERSION });

  // Connection manager with auto-reconnect and keep-alive
  const connectionManager = new ImapConnectionManager(creds);
  const getClient = () => connectionManager.getClient();

  const server = new McpServer({
    name: "imap-mcp-server",
    version: VERSION,
  });

  // Read tier (default: on)
  if (perms.read) {
    listFolders.register(server, getClient);
    searchEmails.register(server, getClient);
    readEmail.register(server, getClient);
    getEmailCount.register(server, getClient);
    downloadAttachment.register(server, getClient);
    getQuota.register(server, getClient);
  }

  // Write tier (default: on)
  if (perms.write) {
    markAsRead.register(server, getClient);
    moveEmail.register(server, getClient);
    flagEmail.register(server, getClient);
    createDraft.register(server, getClient, creds.user);
    replyDraft.register(server, getClient, creds.user);
    manageFolders.registerCreate(server, getClient);
    manageFolders.registerDelete(server, getClient);
    manageFolders.registerRename(server, getClient);
  }

  // Send tier (default: off)
  let smtpConfigured = false;
  if (perms.send) {
    const smtpTransport = createSmtpTransport(creds);
    sendEmail.register(server, smtpTransport, creds.user);
    sendDraft.register(server, getClient, smtpTransport, creds.user);
    smtpConfigured = true;
  }

  // Delete tier (default: off)
  if (perms.delete) {
    deleteEmail.register(server, getClient);
  }

  // Health check (always available)
  healthCheck.register(server, connectionManager, smtpConfigured, VERSION);

  // Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("server.running", { transport: "stdio" });

  // Graceful shutdown
  async function shutdown() {
    log.info("server.shutting_down");
    await connectionManager.shutdown();
    log.closeLogger();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Catch unhandled errors — log but don't crash
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled_rejection", {}, reason);
  });

  process.on("uncaughtException", (err) => {
    log.error("uncaught_exception", {}, err);
  });
}

main().catch((err) => {
  log.error("fatal_error", {}, err);
  process.exit(1);
});
