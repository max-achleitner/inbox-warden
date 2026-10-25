import { setupAudit } from "../audit/setup.js";
import { loadServeConfig } from "../config/load.js";
import { createAppContext } from "../context.js";
import * as log from "../logging/logger.js";
import { withDetectedEndpoints } from "../onboarding/autoconfig.js";
import { createRuntimeSecretStore } from "../secrets/container.js";
import { buildHttpRuntime, createRemoteServer, resolveHttpConfig, type HttpOverrides } from "../transport/http-runtime.js";
import { startHttpServer } from "../transport/http-server.js";

function parseFlags(argv: string[]): HttpOverrides {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const port = value("--port");
  if (port !== undefined && !/^\d{1,5}$/.test(port)) throw new Error(`--port must be a number, got "${port}".`);
  return { host: value("--host"), port: port === undefined ? undefined : Number(port) };
}

export interface ServeHttpHandle {
  /** e.g. http://127.0.0.1:8787 */
  url: string;
  close(): Promise<void>;
}

/**
 * Start `serve --http`. Returns exit code 2 when the configuration is refused (nothing started).
 * Start-up mirrors stdio mode (src/serve.ts): runtime secret store, host autodetection, audit log.
 */
export async function startServeHttp(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<ServeHttpHandle | number> {
  const secrets = createRuntimeSecretStore(env);
  // Env-only accounts only carry address and password; hosts come from autodetection (IMAP_MCP_NO_AUTOCONFIG=1 limits it to the built-in provider table).
  const configEnv = await withDetectedEndpoints(env);
  const config = await loadServeConfig(configEnv, { secrets });
  const http = resolveHttpConfig(config, env, parseFlags(argv));
  const runtime = buildHttpRuntime(config, http, { secrets, createAppContext, createServer: createRemoteServer });

  for (const warning of runtime.check.warnings) log.warn("http.config_warning", { message: warning });
  if (!runtime.ok) {
    for (const error of runtime.check.errors) process.stderr.write(`Error: ${error}\n`);
    return 2;
  }
  setupAudit(runtime.app, env); // fails closed, like stdio mode: no audit trail, no server

  const server = await startHttpServer(runtime.httpApp, { host: http.host, port: http.port, requestTimeoutMs: http.requestTimeoutMs });
  log.info("server.running", { transport: "http", url: server.url, publicUrl: http.publicUrl, auth: runtime.authMode });
  return {
    url: server.url,
    async close() {
      await server.close();
      await runtime.httpApp.close();
      await runtime.app.shutdown();
    },
  };
}

/** `inbox-warden serve --http`: exit code 2 = configuration refused, 0 = clean shutdown after SIGINT/SIGTERM. */
export async function runServeHttp(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  log.initLogger();
  const started = await startServeHttp(argv, env);
  if (typeof started === "number") return started;

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  log.info("server.shutting_down");
  await started.close();
  log.closeLogger();
  return 0;
}
