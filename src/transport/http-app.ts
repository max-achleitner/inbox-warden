import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
  type AuthInfo,
  type McpServer,
} from "@modelcontextprotocol/server";
import type { AppContext } from "../context.js";
import type { HttpConfig } from "../config/http-schema.js";
import { isLoopback } from "../connection-security.js";
import * as log from "../logging/logger.js";
import { RateLimiter, clientIp, createIpAllowlist, jsonResponse, withSecurityHeaders } from "./guards.js";
import type { HttpAuthenticator } from "./auth/authenticator.js";
import { isProtectedResourceMetadataPath, metadataResponse, MCP_PATH, type ProtectedResourceMetadata } from "./auth/metadata.js";
import { AuthError } from "./auth/oauth.js";
import { allowedAccountIds, scopeAppContext, type Principal, type PrincipalRule } from "./auth/principals.js";

export interface HttpAppOptions {
  app: AppContext;
  http: HttpConfig;
  auth: HttpAuthenticator;
  principals: PrincipalRule[];
  /** Builds the MCP server for one request from the (principal-scoped) context. */
  createServer: (app: AppContext) => McpServer;
  /** RFC 9728 document, OAuth mode only. */
  metadata?: ProtectedResourceMetadata;
  now?: () => number;
}

export interface HttpApp {
  fetch(request: Request, remoteAddress: string | undefined): Promise<Response>;
  close(): Promise<void>;
}

function trustedHops(trustProxy: boolean | number): number {
  if (trustProxy === true) return 1;
  if (trustProxy === false) return 0;
  return trustProxy;
}

export function allowedHostnames(http: HttpConfig): string[] {
  const names = new Set(http.allowedHosts.map((h) => h.toLowerCase()));
  if (http.publicUrl) names.add(new URL(http.publicUrl).hostname.toLowerCase());
  if (isLoopback(http.host)) localhostAllowedHostnames().forEach((h) => names.add(h));
  return [...names];
}

const HEALTH_HOSTS = localhostAllowedHostnames();

export function createHttpApp(opts: HttpAppOptions): HttpApp {
  const { http, auth } = opts;
  const now = opts.now ?? Date.now;
  const hops = trustedHops(http.trustProxy);
  const ipAllowed = createIpAllowlist(http.ipAllowlist);
  const hostnames = allowedHostnames(http);
  const authFailures = new RateLimiter({ capacity: http.rateLimit.authFailuresPerMinute, refillPerMinute: http.rateLimit.authFailuresPerMinute, now });
  const perPrincipal = new RateLimiter({ capacity: http.rateLimit.burst, refillPerMinute: http.rateLimit.perMinute, now });
  const accountIds = () => [...opts.app.accounts.keys()];

  const mcp = createMcpHandler(
    (ctx) => {
      const extra = ctx.authInfo?.extra as { principal?: Principal; accounts?: string[] } | undefined;
      if (!extra?.principal || !extra.accounts) throw new Error("Unauthenticated request reached the MCP handler.");
      return opts.createServer(scopeAppContext(opts.app, extra.principal, extra.accounts));
    },
    {
      legacy: "stateless",
      maxRequestBodySize: http.maxBodyBytes,
      onerror: (error) => log.warn("http.mcp_error", { error: error.message }),
    },
  );

  function tooMany(retryAfterSec: number): Response {
    return jsonResponse(429, { error: "rate_limited" }, { "Retry-After": String(retryAfterSec) });
  }

  async function route(request: Request, remoteAddress: string | undefined): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      const rejected = hostHeaderValidationResponse(request, [...hostnames, ...HEALTH_HOSTS]);
      if (rejected) return rejected;
      return request.method === "GET" ? jsonResponse(200, { status: "ok" }) : jsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET" });
    }

    const hostRejected = hostHeaderValidationResponse(request, hostnames);
    if (hostRejected) return hostRejected;

    if (isProtectedResourceMetadataPath(url.pathname)) {
      if (!opts.metadata) return jsonResponse(404, { error: "not_found" });
      return request.method === "GET" ? metadataResponse(opts.metadata) : jsonResponse(405, { error: "method_not_allowed" }, { Allow: "GET" });
    }

    if (url.pathname !== MCP_PATH) return jsonResponse(404, { error: "not_found" });

    const originRejected = originValidationResponse(request, http.allowedOrigins);
    if (originRejected) return originRejected;

    const ip = clientIp(remoteAddress, request.headers.get("x-forwarded-for"), hops);
    if (!ipAllowed(ip)) {
      log.warn("http.ip_rejected", { ip });
      return jsonResponse(403, { error: "forbidden" });
    }

    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    // Connection: close — the unread body must not poison a reused keep-alive socket
    if (declaredLength > http.maxBodyBytes) return jsonResponse(413, { error: "payload_too_large" }, { Connection: "close" });

    let principal: Principal;
    try {
      principal = await auth.authenticate(request.headers.get("authorization"));
    } catch (error) {
      if (error instanceof AuthError) {
        // Missing credentials are the normal discovery step of OAuth clients; only count bad ones.
        if (error.code !== "invalid_request") {
          const limited = authFailures.take(`ip:${ip}`);
          if (!limited.allowed) return tooMany(limited.retryAfterSec);
          log.warn("http.auth_failed", { ip, code: error.code });
        }
        return auth.challenge(error);
      }
      log.error("http.auth_unavailable", {}, error);
      return jsonResponse(503, { error: "temporarily_unavailable" }, { "Retry-After": "30" });
    }

    const accounts = allowedAccountIds(principal, opts.principals, accountIds());
    if (accounts.length === 0) {
      log.warn("http.no_accounts", { principal: principal.id });
      return jsonResponse(403, { error: "forbidden", error_description: "No mailbox is assigned to this identity." });
    }

    const limited = perPrincipal.take(principal.id);
    if (!limited.allowed) return tooMany(limited.retryAfterSec);

    const authInfo: AuthInfo = {
      token: "[redacted]",
      clientId: principal.clientId ?? principal.id,
      scopes: principal.scopes,
      expiresAt: principal.expiresAt,
      extra: { principal, accounts },
    };
    return mcp.fetch(request, { authInfo });
  }

  const hsts = http.publicUrl?.startsWith("https://") ?? false;
  return {
    async fetch(request, remoteAddress) {
      try {
        return withSecurityHeaders(await route(request, remoteAddress), { hsts });
      } catch (error) {
        log.error("http.unhandled", {}, error);
        return withSecurityHeaders(jsonResponse(500, { error: "internal_error" }), { hsts });
      }
    },
    close: () => mcp.close(),
  };
}
