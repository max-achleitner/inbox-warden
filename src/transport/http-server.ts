import { createServer } from "node:http";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import type { HttpApp } from "./http-app.js";

export interface RunningHttpServer {
  /** e.g. http://127.0.0.1:8787 */
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startHttpServer(
  httpApp: HttpApp,
  opts: { host: string; port: number; requestTimeoutMs: number },
): Promise<RunningHttpServer> {
  const listener = getRequestListener(
    (request, env) => httpApp.fetch(request, (env as HttpBindings).incoming.socket.remoteAddress),
    { overrideGlobalObjects: false },
  );
  const server = createServer(listener);
  server.requestTimeout = opts.requestTimeoutMs; // time to receive the full request
  server.headersTimeout = 15_000; // slowloris protection
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
