import type { AccountConfig } from "./schema.js";

/**
 * Sign-in method of the env-only account (MCPB bundle, containers):
 * IMAP_MCP_AUTH = password (default) | microsoft | google, plus IMAP_MCP_OAUTH_CLIENT_ID,
 * IMAP_MCP_OAUTH_CLIENT_SECRET (Google only) and IMAP_MCP_OAUTH_TENANT (Microsoft only).
 * Missing client ids are reported when the account is first used, so Claude can show the message.
 */
export function authFromEnv(env: NodeJS.ProcessEnv, username?: string): AccountConfig["auth"] {
  const kind = (env.IMAP_MCP_AUTH ?? "").trim().toLowerCase() || "password";
  const user = username ? { username } : {};
  if (kind === "password") return { type: "password", ...user };
  if (kind !== "microsoft" && kind !== "google") {
    throw new Error(`IMAP_MCP_AUTH must be "password", "microsoft" or "google" (got "${env.IMAP_MCP_AUTH}").`);
  }
  const value = (name: string) => env[name]?.trim() || undefined;
  const clientId = value("IMAP_MCP_OAUTH_CLIENT_ID");
  const clientSecret = kind === "google" ? value("IMAP_MCP_OAUTH_CLIENT_SECRET") : undefined;
  const tenant = kind === "microsoft" ? value("IMAP_MCP_OAUTH_TENANT") : undefined;
  return {
    type: "oauth2",
    provider: kind,
    ...user,
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(tenant ? { tenant } : {}),
  };
}
