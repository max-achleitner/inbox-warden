import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config/load.js";
import { withDetectedEndpoints } from "./onboarding/autoconfig.js";
import { createAppContext } from "./context.js";
import { setupAudit } from "./audit/setup.js";
import { createRuntimeSecretStore } from "./secrets/container.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";
import * as log from "./logging/logger.js";

export async function serve(args: string[] = []): Promise<void> {
  if (args.includes("--http")) {
    // Remote mode (Plan 7): Streamable HTTP with mandatory authentication. Loaded lazily.
    const { runServeHttp } = await import("./cli/serve-http.js");
    const code = await runServeHttp(args);
    if (code !== 0) process.exitCode = code;
    return;
  }
  log.initLogger();

  const secrets = createRuntimeSecretStore(process.env);
  // Bundle users only enter address and password; hosts come from autodetection (IMAP_MCP_NO_AUTOCONFIG=1 limits it to the built-in provider table).
  const env = await withDetectedEndpoints(process.env);
  const config = await loadConfig(env, { secrets });
  const app = createAppContext(config, secrets);
  setupAudit(app); // fails closed: a server that cannot write its audit trail does not start

  log.info("server.starting", {
    version: VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    accounts: config.accounts.map((a) => ({
      id: a.id,
      permissions: Object.entries(a.permissions).filter(([, on]) => on).map(([tier]) => tier),
    })),
  });

  const handle = serveStdio(() => createServer(app));
  log.info("server.running", { transport: "stdio" });

  // Graceful shutdown
  async function shutdown() {
    log.info("server.shutting_down");
    await handle.close();
    await app.shutdown();
    log.closeLogger();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Catch unhandled errors — log but don't crash
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled_rejection", {}, reason);
  });

  process.on("uncaughtException", (err) => {
    log.error("uncaught_exception", {}, err);
  });
}

