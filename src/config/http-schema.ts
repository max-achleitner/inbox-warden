import { z } from "zod";
import * as path from "node:path";
import { isLoopback } from "../connection-security.js";
import { expandHome } from "../files/sandbox.js";
import { SERVER_NAME } from "../version.js";

/** An origin only: scheme + host (+ port), no path, query or fragment. */
const originUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search && !url.hash && value.replace(/\/$/, "") === url.origin;
  } catch {
    return false;
  }
}, "Must be an origin like https://mail.example.com (no path)");

export const RateLimitSchema = z.object({
  perMinute: z.number().int().min(1).default(120),
  burst: z.number().int().min(1).default(30),
  authFailuresPerMinute: z.number().int().min(1).default(30),
});

export const HttpSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8787),
  /** Public origin clients use, e.g. https://mail.example.com — the MCP endpoint is <publicUrl>/mcp. */
  publicUrl: originUrl.optional(),
  /** Number of reverse proxies in front of the server (true = 1). X-Forwarded-For is ignored when 0/false. */
  trustProxy: z.union([z.boolean(), z.number().int().min(0).max(5)]).default(false),
  maxBodyBytes: z.number().int().min(1024).max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  /** Extra Host header names accepted besides the publicUrl host (and loopback names when bound to loopback). */
  allowedHosts: z.array(z.string().min(1)).default([]),
  /** Origin hostnames accepted when a request carries an Origin header (browser clients). Default: none. */
  allowedOrigins: z.array(z.string().min(1)).default([]),
  /** CIDR ranges allowed to reach /mcp, e.g. ["160.79.104.0/21"] for claude.ai. Empty = no IP restriction. */
  ipAllowlist: z.array(z.string().min(1)).default([]),
  rateLimit: RateLimitSchema.prefault({}),
  requestTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
});

export const PrincipalRuleSchema = z.object({
  match: z
    .object({
      sub: z.string().min(1).optional(),
      email: z.string().min(1).optional(),
      group: z.string().min(1).optional(),
      tokenId: z.string().min(1).optional(),
    })
    .refine((m) => Object.values(m).some((v) => v !== undefined), "match needs at least one of sub, email, group, tokenId"),
  accounts: z.array(z.string().min(1)).min(1),
});

export const BearerTokenSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const HttpAuthSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("bearer"),
    tokens: z.array(BearerTokenSchema).default([]),
    principals: z.array(PrincipalRuleSchema).default([]),
  }),
  z.object({
    mode: z.literal("oauth"),
    issuer: z.string().refine((v) => /^https:\/\//.test(v) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(v), "issuer must be an https URL"),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).transform((a) => (Array.isArray(a) ? a : [a])),
    jwksUri: z.string().optional(),
    /** Checked against the token (scope/scp/roles claims), short names as the IdP puts them into tokens. */
    requiredScopes: z.array(z.string().min(1)).default([]),
    /** Advertised in protected resource metadata (what clients request), e.g. "api://<client-id>/mail.access". Default: requiredScopes. */
    scopesSupported: z.array(z.string().min(1)).optional(),
    clockToleranceSec: z.number().int().min(0).max(300).default(60),
    algorithms: z.array(z.enum(["RS256", "PS256", "ES256", "EdDSA"])).min(1).default(["RS256", "PS256", "ES256"]),
    principals: z.array(PrincipalRuleSchema).min(1, "OAuth mode needs at least one principals rule (who may use which mailbox)"),
  }),
]);

export type HttpConfig = z.output<typeof HttpSchema>;
export type HttpAuthConfig = z.output<typeof HttpAuthSchema>;

export interface DeploymentCheck {
  errors: string[];
  warnings: string[];
}

/** Is `target` the folder `root` or inside it? Compares resolved paths; neither has to exist yet. */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(expandHome(root)), path.resolve(expandHome(target)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Cross-field rules that decide whether `serve --http` may start. */
export function checkHttpDeployment(input: {
  http: HttpConfig;
  httpAuth: HttpAuthConfig | undefined;
  accountIds: string[];
  /** Accounts that may send and use send mode "confirm". */
  confirmSendAccounts?: string[];
  files?: { attachmentDirs: string[]; downloadDir?: string };
}): DeploymentCheck {
  const { http, httpAuth, accountIds, confirmSendAccounts = [], files } = input;
  const errors: string[] = [];
  const warnings: string[] = [];
  const loopbackBind = isLoopback(http.host);

  if (!httpAuth) {
    errors.push(`HTTP mode requires "httpAuth" (bearer tokens or OAuth). Run \`${SERVER_NAME} http token create --id <name>\`.`);
  } else if (httpAuth.mode === "bearer" && httpAuth.tokens.length === 0) {
    errors.push(`No bearer tokens configured. Run \`${SERVER_NAME} http token create --id <name>\`.`);
  } else if (httpAuth.mode === "oauth") {
    if (!http.publicUrl) errors.push('OAuth mode requires "http.publicUrl" (the HTTPS origin clients connect to).');
    else if (!http.publicUrl.startsWith("https://") && !isLoopback(new URL(http.publicUrl).hostname)) {
      errors.push('"http.publicUrl" must use https:// outside of local testing.');
    }
  }
  if (!loopbackBind && !http.publicUrl && http.allowedHosts.length === 0) {
    errors.push('Bound to a non-loopback address: set "http.publicUrl" or "http.allowedHosts" so Host headers can be checked.');
  }
  for (const rule of httpAuth?.principals ?? []) {
    for (const id of rule.accounts) {
      if (id !== "*" && !accountIds.includes(id)) errors.push(`principals rule refers to unknown account "${id}".`);
    }
  }
  if (!loopbackBind && http.trustProxy === false && http.ipAllowlist.length === 0) {
    warnings.push("Listening on a public interface without a reverse proxy or IP allowlist. Put Caddy/nginx with TLS in front.");
  }
  if (httpAuth?.mode === "bearer" && httpAuth.principals.length === 0 && accountIds.length > 1) {
    warnings.push("Every bearer token can use every mailbox. Add httpAuth.principals rules to restrict tokens.");
  }
  const downloadDir = files?.downloadDir;
  if (accountIds.length > 1 && downloadDir && files.attachmentDirs.some((dir) => isWithin(dir, downloadDir))) {
    warnings.push(
      '"files.downloadDir" lies inside "files.attachmentDirs": an attachment saved from one mailbox can be attached and sent from any other. ' +
        "Keep the two folders apart when callers are limited to different mailboxes.",
    );
  }
  if (confirmSendAccounts.length > 0) {
    warnings.push(
      `${confirmSendAccounts.map((id) => `"${id}"`).join(", ")} use send mode "confirm": over HTTP only clients on MCP protocol 2026-07-28 or later can show the confirmation. ` +
        'Sends from older clients are refused (drafts still work). Set policy.send.mode to "direct" to rely on the client\'s own approval prompt, or "drafts-only".',
    );
  }
  return { errors, warnings };
}
