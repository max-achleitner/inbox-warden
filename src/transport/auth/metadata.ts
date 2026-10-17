import { jsonResponse } from "../guards.js";
import { SERVER_NAME } from "../../version.js";

export const MCP_PATH = "/mcp";
const PRM_ROOT = "/.well-known/oauth-protected-resource";

/** The protected resource identifier (RFC 8707/9728): the MCP endpoint URL. `publicUrl` is an origin. */
export function mcpResourceUrl(publicUrl: string): string {
  return new URL(MCP_PATH, publicUrl).toString();
}

/** RFC 9728 path-aware metadata URL: https://host/.well-known/oauth-protected-resource/mcp */
export function protectedResourceMetadataUrl(publicUrl: string): string {
  return new URL(PRM_ROOT + MCP_PATH, publicUrl).toString();
}

/** Both the path-aware and the root form are served with the same document. */
export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname === PRM_ROOT || pathname === PRM_ROOT + MCP_PATH;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ["header"];
  resource_name: string;
}

export function buildProtectedResourceMetadata(opts: {
  publicUrl: string;
  issuer: string;
  scopes: string[];
  resourceName?: string;
}): ProtectedResourceMetadata {
  return {
    resource: mcpResourceUrl(opts.publicUrl),
    authorization_servers: [opts.issuer],
    scopes_supported: opts.scopes,
    bearer_methods_supported: ["header"],
    resource_name: opts.resourceName ?? SERVER_NAME,
  };
}

/** `Bearer key="value", …` — quotes and backslashes are stripped from values. */
export function bearerChallenge(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}="${value.replace(/["\\]/g, "")}"`);
  return parts.length > 0 ? `Bearer ${parts.join(", ")}` : "Bearer";
}

export function metadataResponse(doc: ProtectedResourceMetadata): Response {
  // Public, secret-free document: allow browser-based MCP clients to read it.
  return jsonResponse(200, doc, { "Access-Control-Allow-Origin": "*" });
}
