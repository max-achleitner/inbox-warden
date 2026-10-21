import type { McpServer } from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import { defineTool } from "./shared/define-tool.js";
import { jsonResult } from "./shared/result.js";
import { scanStats } from "../security/injection-detector.js";
import { VERSION } from "../version.js";

const serverStartTime = new Date();

export function register(server: McpServer, app: AppContext) {
  defineTool(
    server,
    app,
    {
      name: "health_check",
      title: "Server health",
      description:
        "Check the health of the MCP server: connection state per mail account, SMTP configuration (smtp.configured) and whether sending is allowed (smtp.sendAllowed), and security scan statistics (security.totalScans/totalDetections count since the server started, see security.since)",
      tier: "always",
      input: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      errorPrefix: "Error checking health",
    },
    async () => {
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
        // Taken after getClient(): when the check opens the connection, connectedSince is newer than the call
        const checkedAt = new Date();
        const stats = account.connectionStats();
        accounts.push({
          id: account.id,
          status,
          ...(error ? { error } : {}),
          imap: {
            connected: stats.connected,
            server: stats.server,
            lastActivity: stats.lastActivity?.toISOString() ?? null,
            uptime: stats.connectedSince ? Math.max(0, Math.floor((checkedAt.getTime() - stats.connectedSince.getTime()) / 1000)) : 0,
            reconnectCount: stats.reconnectCount,
          },
          smtp: { configured: account.config.smtp !== undefined, sendAllowed: account.config.permissions.send },
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
        // Counted per process: they start at 0 when the server starts (`since`)
        security: { injectionDetection: true, ...scanStats(), since: serverStartTime.toISOString() },
        server: {
          uptime: Math.floor((Date.now() - serverStartTime.getTime()) / 1000),
          version: VERSION,
          nodeVersion: process.version,
          platform: process.platform,
        },
      });
    },
  );
}
