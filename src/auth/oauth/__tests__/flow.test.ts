import { describe, it, expect } from "vitest";
import { browserCommand, openBrowser } from "../browser.js";
import { OAuthAuthorizationError, OAuthTimeoutError } from "../errors.js";
import { runLoopbackAuthorization } from "../flow.js";
import { startLoopbackReceiver } from "../loopback.js";
import { googleProfile, microsoftProfile } from "../profiles.js";
import type { FetchLike } from "../tokens.js";

/** A port that was free a moment ago (for fixed-port tests). */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("loopback receiver", () => {
  it("listens on loopback and resolves the code for the matching state", async () => {
    const receiver = await startLoopbackReceiver({ state: "s1", redirectHost: "127.0.0.1", timeoutMs: 5000 });
    try {
      expect(receiver.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${receiver.redirectUri}/?code=abc&state=s1`);
      expect(res.status).toBe(200);
      expect(await receiver.waitForCode()).toBe("abc");
    } finally {
      await receiver.close();
    }
  });

  it("ignores redirects with a foreign state", async () => {
    const receiver = await startLoopbackReceiver({ state: "good", redirectHost: "127.0.0.1", timeoutMs: 5000 });
    try {
      const bad = await fetch(`${receiver.redirectUri}/?code=evil&state=bad`);
      expect(bad.status).toBe(400);
      await fetch(`${receiver.redirectUri}/?code=real&state=good`);
      expect(await receiver.waitForCode()).toBe("real");
    } finally {
      await receiver.close();
    }
  });

  it("rejects when the provider reports an error", async () => {
    const receiver = await startLoopbackReceiver({ state: "s", redirectHost: "127.0.0.1", timeoutMs: 5000 });
    try {
      await fetch(`${receiver.redirectUri}/?error=access_denied&state=s`);
      await expect(receiver.waitForCode()).rejects.toBeInstanceOf(OAuthAuthorizationError);
    } finally {
      await receiver.close();
    }
  });

  it("times out", async () => {
    const receiver = await startLoopbackReceiver({ state: "s", redirectHost: "127.0.0.1", timeoutMs: 50 });
    try {
      await expect(receiver.waitForCode()).rejects.toBeInstanceOf(OAuthTimeoutError);
    } finally {
      await receiver.close();
    }
  });

  it("honours listenHost and a fixed port (container: --listen-host 0.0.0.0 --port 53682)", async () => {
    const port = await freePort();
    const receiver = await startLoopbackReceiver({ state: "s", redirectHost: "localhost", listenHost: "0.0.0.0", port, timeoutMs: 5000 });
    try {
      // the redirect URI keeps the loopback name; the browser reaches the container through the published port
      expect(receiver.redirectUri).toBe(`http://localhost:${port}`);
      await fetch(`http://127.0.0.1:${port}/?code=c&state=s`);
      expect(await receiver.waitForCode()).toBe("c");
    } finally {
      await receiver.close();
    }
  });

  it("uses http://localhost:<port> for Microsoft", async () => {
    const receiver = await startLoopbackReceiver({ state: "s", redirectHost: "localhost", timeoutMs: 1000 });
    try {
      expect(receiver.redirectUri).toMatch(/^http:\/\/localhost:\d+$/);
    } finally {
      await receiver.close();
    }
  });
});

describe("browser opening", () => {
  it("never uses a shell on Windows", () => {
    expect(browserCommand("https://x.test/?a=1&b=2", "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", "https://x.test/?a=1&b=2"],
    });
    expect(browserCommand("https://x.test", "darwin").command).toBe("open");
    expect(browserCommand("https://x.test", "linux").command).toBe("xdg-open");
  });

  it("refuses non-https URLs", async () => {
    expect(await openBrowser("file:///etc/passwd")).toBe(false);
  });
});

describe("runLoopbackAuthorization", () => {
  it("drives the browser, receives the code and exchanges it with the verifier", async () => {
    const posted: URLSearchParams[] = [];
    const fetchToken: FetchLike = async (_url, init) => {
      posted.push(new URLSearchParams(init.body));
      return { status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600 }) };
    };
    const lines: string[] = [];
    const tokens = await runLoopbackAuthorization(googleProfile({ clientId: "cid", clientSecret: "sec" }), {
      print: (l) => lines.push(l),
      tokenDeps: { fetch: fetchToken },
      openBrowser: async (url) => {
        const u = new URL(url);
        const redirect = u.searchParams.get("redirect_uri")!;
        await fetch(`${redirect}/?code=the-code&state=${u.searchParams.get("state")}`);
        return true;
      },
    });
    expect(tokens.refreshToken).toBe("rt");
    expect(posted[0].get("code")).toBe("the-code");
    expect(posted[0].get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lines.some((l) => l.startsWith("https://accounts.google.com/"))).toBe(true);
  });

  it("with openBrowser: false only prints the link and listens where asked", async () => {
    const port = await freePort();
    const fetchToken: FetchLike = async () => ({ status: 200, json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600 }) });
    const lines: string[] = [];
    const flow = runLoopbackAuthorization(microsoftProfile({ clientId: "cid" }), {
      print: (l) => lines.push(l),
      openBrowser: false,
      port,
      tokenDeps: { fetch: fetchToken },
      onAuthorizeUrl: (url) => {
        const u = new URL(url);
        expect(u.searchParams.get("redirect_uri")).toBe(`http://localhost:${port}`);
        void fetch(`http://127.0.0.1:${port}/?code=c&state=${u.searchParams.get("state")}`);
      },
    });
    expect((await flow).refreshToken).toBe("rt");
    expect(lines.some((l) => l.includes("could not be opened"))).toBe(false);
  });

  it("fails clearly when no refresh token comes back", async () => {
    const fetchToken: FetchLike = async () => ({ status: 200, json: async () => ({ access_token: "at", expires_in: 3600 }) });
    await expect(
      runLoopbackAuthorization(microsoftProfile({ clientId: "cid" }), {
        print: () => {},
        tokenDeps: { fetch: fetchToken },
        openBrowser: async (url) => {
          const u = new URL(url);
          const port = new URL(u.searchParams.get("redirect_uri")!).port;
          await fetch(`http://127.0.0.1:${port}/?code=c&state=${u.searchParams.get("state")}`);
          return true;
        },
      }),
    ).rejects.toThrow(/refresh token/);
  });
});
