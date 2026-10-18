import { z } from "zod";
import { normalizeDomainPattern } from "./recipients.js";

const DomainPatternSchema = z
  .string()
  .refine((value) => normalizeDomainPattern(value) !== null, {
    message: "Use a domain like example.com or *.example.com",
  })
  .transform((value) => normalizeDomainPattern(value)!);

/**
 * Policy objects are strict: a misspelt security setting ("maxPerHours") must fail loudly
 * instead of being ignored.
 */
export const SendPolicySchema = z.strictObject({
  /** drafts-only: send tools are not offered; confirm: ask the user before each send; direct: no extra question. */
  mode: z.enum(["drafts-only", "confirm", "direct"]).default("confirm"),
  allowedRecipientDomains: z.array(DomainPatternSchema).optional(),
  blockedRecipientDomains: z.array(DomainPatternSchema).default([]),
  maxRecipients: z.number().int().min(1).max(500).default(20),
  maxPerHour: z.number().int().min(0).default(20),
  maxPerDay: z.number().int().min(0).default(100),
  flagNewRecipients: z.boolean().default(true),
  /** After reading an email at or above this injection risk, every send needs confirmation for one hour. */
  confirmAfterInjectionRisk: z.enum(["medium", "high", "critical", "never"]).default("medium"),
  /** true: refuse to send when the client cannot show a confirmation dialog (no fallback to client approval). */
  requireElicitation: z.boolean().default(false),
});

export const BulkPolicySchema = z.strictObject({
  maxMessages: z.number().int().min(1).default(500),
  maxDelete: z.number().int().min(1).default(100),
});

export const FolderPolicySchema = z.strictObject({
  // An empty list would read as "nothing allowed" to one admin and "no restriction" to another
  allow: z
    .array(z.string().min(1))
    .min(1, "folders.allow needs at least one folder pattern; leave it out to allow every folder")
    .optional(),
  deny: z.array(z.string().min(1)).default([]),
});

export const AttachmentPolicySchema = z.strictObject({
  maxDownloadBytes: z.number().int().min(1).default(25 * 1024 * 1024),
  blockExecutables: z.boolean().default(true),
});

export const PolicySchema = z.strictObject({
  send: SendPolicySchema.prefault({}),
  bulk: BulkPolicySchema.prefault({}),
  folders: FolderPolicySchema.prefault({}),
  protectedFolders: z.boolean().default(true),
  attachments: AttachmentPolicySchema.prefault({}),
});

export type Policy = z.output<typeof PolicySchema>;
