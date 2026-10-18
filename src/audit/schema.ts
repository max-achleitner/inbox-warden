import { z } from "zod";

export const DEFAULT_RETENTION_DAYS = 365;

export const AuditSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Folder for the monthly audit files; default CONFIG_DIR/audit. */
  path: z.string().min(1).optional(),
  /** minimal: no subjects, recipients reduced to count + domains. */
  level: z.enum(["minimal", "standard"]).default("standard"),
  retentionDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION_DAYS),
  /** Also record read-only tool calls (who looked at which folder/message). */
  includeReads: z.boolean().default(false),
});

export type AuditConfig = z.output<typeof AuditSchema>;
