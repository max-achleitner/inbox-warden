import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapConnectionManager, ConnectionStats } from "../imap-client.js";
import { errorMessage } from "../errors.js";

const serverStartTime = new Date();

// Track security scan stats globally
let totalScans = 0;
let totalDetections = 0;

export function recordScan(hasInjection: boolean): void {
  totalScans++;
  if (hasInjection) totalDetections++;
}

export function register(
  server: McpServer,
  connectionManager: ImapConnectionManager,
  smtpConfigured: boolean,
  version: string,
) {
  server.tool(
    "health_check",
    "Check the health status of the MCP server, IMAP connection, and security systems",
    {},
    { readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        // Determine overall status — try connecting if not connected
        let status: "healthy" | "degraded" | "unhealthy" = "unhealthy";
        const initialStats = connectionManager.stats;
        if (initialStats.connected) {
          status = "healthy";
        } else {
          try {
            await connectionManager.getClient();
            status = connectionManager.stats.reconnectCount > 0 ? "degraded" : "healthy";
          } catch {
            status = "unhealthy";
          }
        }

        // Read stats AFTER potential reconnect so all values are fresh
        const stats = connectionManager.stats;
        const now = new Date();
        const serverUptime = Math.floor((now.getTime() - serverStartTime.getTime()) / 1000);

        const result = {
          status,
          imap: {
            connected: stats.connected,
            lastActivity: stats.lastActivity?.toISOString() ?? null,
            uptime: stats.connectedSince
              ? Math.floor((now.getTime() - stats.connectedSince.getTime()) / 1000)
              : 0,
            server: stats.server,
            reconnectCount: stats.reconnectCount,
          },
          smtp: {
            configured: smtpConfigured,
          },
          security: {
            injectionDetection: true,
            totalScans,
            totalDetections,
          },
          server: {
            uptime: serverUptime,
            version,
            nodeVersion: process.version,
          },
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error checking health: ${errorMessage(error)}` }],
          isError: true,
        };
      }
    }
  );
}
