import * as path from "node:path";
import { configDir } from "../config/load.js";
import type { AppConfig } from "../config/schema.js";
import type { AppContext } from "../context.js";
import { AuditLog } from "./audit-log.js";

/** Folder of the monthly audit files: `audit.path`, else `<config dir>/audit` (IMAP_MCP_HOME respected). */
export function auditDir(config: Pick<AppConfig, "audit">, env: NodeJS.ProcessEnv = process.env): string {
  return config.audit.path ?? path.join(configDir(env), "audit");
}

/**
 * Register the audit log as a tool observer. Fails closed: throws when the audit folder is not
 * writable, so the server does not start without its audit trail. Old month files are pruned.
 */
export function setupAudit(app: Pick<AppContext, "config" | "observers">, env: NodeJS.ProcessEnv = process.env): AuditLog | null {
  const { audit } = app.config;
  if (!audit.enabled) return null;
  const log = new AuditLog({
    dir: auditDir(app.config, env),
    level: audit.level,
    retentionDays: audit.retentionDays,
    includeReads: audit.includeReads,
  });
  log.ensureWritable();
  log.cleanup();
  app.observers.push(log);
  return log;
}
