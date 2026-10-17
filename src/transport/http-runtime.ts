import type { McpServer } from "@modelcontextprotocol/server";
import { LOCAL_ONLY_TOOLS, createServer } from "../server.js";
import type { AppConfig } from "../config/schema.js";
import type { AppContext } from "../context.js";
import type { SecretStore } from "../secrets/store.js";
import { HttpSchema, checkHttpDeployment, type DeploymentCheck, type HttpConfig } from "../config/http-schema.js";
import { createHttpAuthenticator } from "./auth/authenticator.js";
import { buildProtectedResourceMetadata } from "./auth/metadata.js";
import type { JwtVerifierDeps } from "./auth/oauth.js";
import { createHttpApp, type HttpApp } from "./http-app.js";

export interface HttpOverrides {
  host?: string;
  port?: number;
}

export interface HttpRuntimeDeps {
  secrets: SecretStore;
  createAppContext(config: AppConfig, secrets: SecretStore): AppContext;
  createServer(app: AppContext): McpServer;
  jwt?: JwtVerifierDeps;
}

export type HttpRuntime =
  | { ok: false; check: DeploymentCheck }
  | { ok: true; check: DeploymentCheck; http: HttpConfig; app: AppContext; httpApp: HttpApp; authMode: "bearer" | "oauth" };

/** The per-request server in HTTP mode: every tool except those that act on the server machine (LOCAL_ONLY_TOOLS). */
export function createRemoteServer(app: AppContext): McpServer {
  return createServer(app, { exclude: LOCAL_ONLY_TOOLS });
}

/** Effective HTTP settings: config file < IMAP_MCP_HTTP_HOST/PORT env < CLI flags. */
export function resolveHttpConfig(config: AppConfig, env: NodeJS.ProcessEnv, flags: HttpOverrides): HttpConfig {
  const base = HttpSchema.parse(config.http ?? {});
  const envPort = env.IMAP_MCP_HTTP_PORT ? Number(env.IMAP_MCP_HTTP_PORT) : undefined;
  return HttpSchema.parse({
    ...base,
    host: flags.host ?? (env.IMAP_MCP_HTTP_HOST || undefined) ?? base.host,
    port: flags.port ?? envPort ?? base.port,
  });
}

/** Validate first; only a deployable configuration creates account runtimes (IMAP connections). */
export function buildHttpRuntime(config: AppConfig, http: HttpConfig, deps: HttpRuntimeDeps): HttpRuntime {
  const check = checkHttpDeployment({
    http,
    httpAuth: config.httpAuth,
    accountIds: config.accounts.map((a) => a.id),
    confirmSendAccounts: config.accounts.filter((a) => a.permissions.send && a.policy.send.mode === "confirm").map((a) => a.id),
    files: config.files,
  });
  if (check.errors.length > 0 || !config.httpAuth) return { ok: false, check };

  const httpAuth = config.httpAuth;
  const app = deps.createAppContext(config, deps.secrets);
  const auth = createHttpAuthenticator(httpAuth, http.publicUrl, deps.jwt);
  const metadata =
    httpAuth.mode === "oauth" && http.publicUrl
      ? buildProtectedResourceMetadata({
          publicUrl: http.publicUrl,
          issuer: httpAuth.issuer,
          scopes: httpAuth.scopesSupported ?? httpAuth.requiredScopes,
        })
      : undefined;
  const httpApp = createHttpApp({
    app,
    http,
    auth,
    principals: httpAuth.principals,
    createServer: deps.createServer,
    metadata,
  });
  return { ok: true, check, http, app, httpApp, authMode: httpAuth.mode };
}
