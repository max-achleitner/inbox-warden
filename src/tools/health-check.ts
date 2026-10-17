import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";
import { VERSION } from "../version.js";

const serverStartTime = new Date();

// Track security scan stats globally
let totalScans = 0;
let totalDetections = 0;

export function recordScan(hasInjection: boolean): void {
  totalScans++;
  if (hasInjection) totalDetections++;
}

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "health_check",
      title: "Server health",
      description: "Check the health of the MCP server: connection state per mail account, SMTP configuration and security scan statistics",
      tier: "always",
      input: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      errorPrefix: "Error checking health",
    },
    async () => {
      const now = new Date();
      const accounts = [];
      for (const account of app.accounts.values()) {
        let status: "healthy" | "degraded" | "unhealthy" = "unhealthy";
        let error: string | undefined;
        try {
          await account.getClient();
          status = account.connectionStats().reconnectCount > 0 ? "degraded" : "healthy";
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        const stats = account.connectionStats();
        accounts.push({
          id: account.id,
          status,
          ...(error ? { error } : {}),
          imap: {
            connected: stats.connected,
            server: stats.server,
            lastActivity: stats.lastActivity?.toISOString() ?? null,
            uptime: stats.connectedSince ? Math.floor((now.getTime() - stats.connectedSince.getTime()) / 1000) : 0,
            reconnectCount: stats.reconnectCount,
          },
          smtp: { configured: account.config.smtp !== undefined && account.config.permissions.send },
        });
      }

      const overall = accounts.every((a) => a.status === "healthy")
        ? "healthy"
        : accounts.some((a) => a.status !== "unhealthy")
          ? "degraded"
          : "unhealthy";

      return jsonResult({
        status: overall,
        accounts,
        security: { injectionDetection: true, totalScans, totalDetections },
        server: {
          uptime: Math.floor((now.getTime() - serverStartTime.getTime()) / 1000),
          version: VERSION,
          nodeVersion: process.version,
          platform: process.platform,
        },
      });
    },
  );
}
