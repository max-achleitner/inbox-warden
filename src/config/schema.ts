import { z } from "zod";
import { HttpAuthSchema, HttpSchema } from "./http-schema.js";
import { certificateFingerprint256 } from "../connection-security.js";
import { PolicySchema } from "../policy/schema.js";
import { AuditSchema } from "../audit/schema.js";

export { PolicySchema, AuditSchema };

export const PermissionsSchema = z.object({
  read: z.boolean().default(true),
  write: z.boolean().default(true),
  send: z.boolean().default(false),
  delete: z.boolean().default(false),
});

export const IdentitySchema = z.object({
  email: z.email(),
  name: z.string().min(1).optional(),
  /** Plain-text signature, appended after the standard "-- " separator. */
  signature: z.string().optional(),
  signatureHtml: z.string().optional(),
});

export const EndpointSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** SHA-256 certificate fingerprint for self-signed servers (used from Plan 4). */
  tlsFingerprint256: z
    .string()
    .regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, "Use the colon-separated upper-case SHA-256 fingerprint")
    .optional(),
  /** PEM of the pinned certificate; set together with tlsFingerprint256 (checked in ConfigSchema). */
  tlsCertificatePem: z.string().startsWith("-----BEGIN CERTIFICATE-----").optional(),
});

/** Problem with a certificate pin, or undefined when the endpoint is consistent. */
export function pinProblem(endpoint: { tlsFingerprint256?: string; tlsCertificatePem?: string }): string | undefined {
  const { tlsFingerprint256: fingerprint, tlsCertificatePem: pem } = endpoint;
  if ((fingerprint === undefined) !== (pem === undefined)) return "tlsFingerprint256 and tlsCertificatePem must be set together";
  if (pem === undefined) return undefined;
  try {
    return certificateFingerprint256(pem) === fingerprint ? undefined : "tlsFingerprint256 does not match tlsCertificatePem";
  } catch {
    return "tlsCertificatePem is not a valid certificate";
  }
}

export const AuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("password"), username: z.string().min(1).optional() }),
  z.object({
    type: z.literal("oauth2"),
    provider: z.enum(["microsoft", "google"]),
    username: z.string().min(1).optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    tenant: z.string().optional(),
  }),
]);

/** Local folders the AI may use, and how much attachment content may enter the AI context. */
export const FilesSchema = z.object({
  /** Folders the AI may attach files from (relative paths are resolved inside them). */
  attachmentDirs: z.array(z.string().min(1)).default([]),
  /** Folder that save_attachment writes into. Unset = saving disabled. */
  downloadDir: z.string().min(1).optional(),
  /** Largest text attachment returned to the AI (UTF-8). */
  maxInlineTextBytes: z.number().int().min(1024).max(1024 * 1024).default(100 * 1024),
  /** Largest image attachment returned to the AI as MCP image content. */
  maxInlineImageBytes: z.number().int().min(1024).max(5 * 1024 * 1024).default(1024 * 1024),
});

export const AccountSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Use 1–32 lower-case letters, digits or dashes"),
  label: z.string().optional(),
  email: z.email(),
  imap: EndpointSchema,
  smtp: EndpointSchema.optional(),
  auth: AuthSchema.default({ type: "password" }),
  identities: z.array(IdentitySchema).default([]),
  permissions: PermissionsSchema.prefault({}),
  sentCopy: z.enum(["auto", "always", "never"]).default("auto"),
  locale: z.enum(["de", "en"]).default("en"),
  policy: PolicySchema.prefault({}),
});

export const ConfigSchema = z
  .object({
    version: z.literal(2),
    defaultAccount: z.string().optional(),
    accounts: z.array(AccountSchema).min(1),
    files: FilesSchema.prefault({}),
    audit: AuditSchema.prefault({}),
    http: HttpSchema.optional(),
    httpAuth: HttpAuthSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [index, account] of config.accounts.entries()) {
      if (seen.has(account.id)) {
        ctx.addIssue({ code: "custom", path: ["accounts", index, "id"], message: `Duplicate account id "${account.id}"` });
      }
      seen.add(account.id);
      for (const endpoint of ["imap", "smtp"] as const) {
        const problem = account[endpoint] ? pinProblem(account[endpoint]) : undefined;
        if (problem) ctx.addIssue({ code: "custom", path: ["accounts", index, endpoint], message: problem });
      }
    }
    if (config.defaultAccount && !seen.has(config.defaultAccount)) {
      ctx.addIssue({ code: "custom", path: ["defaultAccount"], message: `defaultAccount "${config.defaultAccount}" is not an account id` });
    }
  });

export type AppConfig = z.output<typeof ConfigSchema>;
export type AccountConfig = z.output<typeof AccountSchema>;
export type Identity = z.output<typeof IdentitySchema>;
export type Permissions = z.output<typeof PermissionsSchema>;
export type PermissionTier = keyof Permissions;
