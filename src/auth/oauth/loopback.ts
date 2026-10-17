import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OAuthAuthorizationError, OAuthTimeoutError } from "./errors.js";
import { SERVER_NAME } from "../../version.js";

export interface LoopbackReceiver {
  /** The redirect_uri to send to the provider, e.g. "http://localhost:53123". */
  redirectUri: string;
  /** Resolves with the authorization code of the redirect whose `state` matches. */
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export interface LoopbackOptions {
  state: string;
  /** Host in the redirect URI the browser is sent to. */
  redirectHost: "localhost" | "127.0.0.1";
  /** Interface to listen on (default 127.0.0.1). "0.0.0.0" only inside a container whose port is published to the host loopback. */
  listenHost?: string;
  /** Fixed port (default: a random free port); needed when the port is published from a container. */
  port?: number;
  timeoutMs?: number;
  language?: "de" | "en";
}

const PAGES = {
  de: {
    ok: "Anmeldung erfolgreich. Sie können dieses Fenster schließen und zum Setup zurückkehren.",
    fail: "Die Anmeldung ist fehlgeschlagen. Sie können dieses Fenster schließen; Details stehen im Setup-Fenster.",
  },
  en: {
    ok: "Sign-in complete. You can close this window and return to the setup.",
    fail: "Sign-in failed. You can close this window; details are shown in the setup window.",
  },
};

function page(text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${SERVER_NAME}</title></head><body style="font-family:sans-serif;margin:3em"><p>${text}</p></body></html>`;
}

/**
 * One-shot HTTP listener on the loopback interface for the OAuth redirect (RFC 8252 §7.3).
 * Requests with a wrong `state` are answered with 400 and ignored, so another local page
 * cannot inject a code into this sign-in.
 */
export async function startLoopbackReceiver(opts: LoopbackOptions): Promise<LoopbackReceiver> {
  const texts = PAGES[opts.language ?? "en"];
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  result.catch(() => {}); // rejection is observed through waitForCode()

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/" || (!url.searchParams.has("code") && !url.searchParams.has("error"))) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== opts.state) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid state");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(texts.fail));
      settle.reject(new OAuthAuthorizationError(error, url.searchParams.get("error_description") ?? undefined));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(texts.ok));
    settle.resolve(url.searchParams.get("code")!);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.listenHost ?? "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(() => settle.reject(new OAuthTimeoutError("Browser sign-in")), opts.timeoutMs ?? 5 * 60_000);
  timer.unref();

  return {
    redirectUri: `http://${opts.redirectHost}:${port}`,
    waitForCode: () => result,
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
