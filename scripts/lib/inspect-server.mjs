import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/**
 * Environment for starting a built server without touching any real mailbox: env-only mode,
 * an empty home directory and a closed local port. Listing tools never connects to IMAP.
 */
export function offlineEnv(home, permissions) {
  const env = {
    IMAP_MCP_HOME: home,
    IMAP_MCP_EMAIL: "build@example.invalid",
    IMAP_MCP_PASSWORD: "not-used",
    IMAP_MCP_IMAP_HOST: "127.0.0.1",
    IMAP_MCP_IMAP_PORT: "9",
    IMAP_MCP_SMTP_HOST: "127.0.0.1",
    IMAP_MCP_SMTP_PORT: "9",
    IMAP_MCP_PERMISSIONS: permissions,
    IMAP_MCP_NO_AUTOCONFIG: "1",
    LOG_LEVEL: "error",
  };
  for (const key of ["PATH", "SystemRoot", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

/** Start `node <entry> serve` over stdio and list its tools. */
export async function inspectServer({ entry, env }) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "serve"], env, stderr: "inherit" });
  const client = new Client({ name: "inbox-warden-build", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return { tools, serverVersion: client.getServerVersion() };
  } finally {
    await client.close();
  }
}
