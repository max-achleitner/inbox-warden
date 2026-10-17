import { describe, it, expect } from "vitest";
import { RateLimiter, clientIp, createIpAllowlist, withSecurityHeaders } from "../guards.js";

describe("clientIp", () => {
  it("ignores X-Forwarded-For when no proxy is trusted", () => {
    expect(clientIp("203.0.113.9", "1.2.3.4", 0)).toBe("203.0.113.9");
  });

  it("uses the address appended by the trusted proxy, never attacker-supplied entries", () => {
    // attacker sends "X-Forwarded-For: 160.79.104.10"; Caddy appends the real peer 198.51.100.7
    expect(clientIp("172.18.0.2", "160.79.104.10, 198.51.100.7", 1)).toBe("198.51.100.7");
  });

  it("normalises IPv4-mapped IPv6 peers", () => {
    expect(clientIp("::ffff:127.0.0.1", null, 0)).toBe("127.0.0.1");
  });

  it("falls back to the peer address when the forwarded entry is not an IP", () => {
    expect(clientIp("172.18.0.2", "unknown", 1)).toBe("172.18.0.2");
  });
});

describe("createIpAllowlist", () => {
  it("allows everything when empty", () => {
    expect(createIpAllowlist([])("8.8.8.8")).toBe(true);
  });

  it("matches the Anthropic egress range and single addresses", () => {
    const allowed = createIpAllowlist(["160.79.104.0/21", "2001:db8::/32", "10.0.0.5"]);
    expect(allowed("160.79.111.255")).toBe(true);
    expect(allowed("160.79.112.0")).toBe(false);
    expect(allowed("2001:db8::1")).toBe(true);
    expect(allowed("10.0.0.5")).toBe(true);
    expect(allowed("10.0.0.6")).toBe(false);
    expect(allowed("not-an-ip")).toBe(false);
  });

  it("rejects invalid ranges at startup", () => {
    expect(() => createIpAllowlist(["160.79.104.0/33"])).toThrow(/prefix/);
    expect(() => createIpAllowlist(["example.com/24"])).toThrow(/Invalid IP range/);
  });
});

describe("RateLimiter", () => {
  it("allows a burst, then reports Retry-After until tokens refill", () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerMinute: 60, now: () => now });
    expect(limiter.take("p").allowed).toBe(true);
    expect(limiter.take("p").allowed).toBe(true);
    const third = limiter.take("p");
    expect(third).toEqual({ allowed: false, retryAfterSec: 1 });
    now += 1000;
    expect(limiter.take("p").allowed).toBe(true);
    expect(limiter.take("other").allowed).toBe(true);
  });

  it("bounds memory by evicting the oldest key", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerMinute: 1, maxKeys: 2, now: () => 0 });
    limiter.take("a");
    limiter.take("b");
    limiter.take("c");
    expect(limiter.take("a").allowed).toBe(true); // "a" was evicted and starts with a full bucket
  });
});

describe("withSecurityHeaders", () => {
  it("adds headers without consuming a streamed body", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
        controller.close();
      },
    });
    const res = withSecurityHeaders(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }), { hsts: true });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age/);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await res.text()).toBe("data: 1\n\n");
  });
});
