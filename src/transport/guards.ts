import { BlockList, isIP } from "node:net";

/** "::ffff:203.0.113.7" → "203.0.113.7"; trims whitespace. */
export function normalizeIp(ip: string): string {
  const value = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return mapped ? mapped[1] : value;
}

/**
 * The client address as seen by the outermost trusted proxy.
 * `trustedHops` = number of reverse proxies in front of this server (0 = ignore X-Forwarded-For).
 * Entries left of the trusted hops are attacker-controlled and are never used.
 */
export function clientIp(remoteAddress: string | undefined, forwardedFor: string | null, trustedHops: number): string {
  const remote = normalizeIp(remoteAddress ?? "");
  if (trustedHops <= 0 || !forwardedFor) return remote;
  const chain = [
    ...forwardedFor
      .split(",")
      .map((part) => normalizeIp(part))
      .filter((part) => part.length > 0),
    remote,
  ];
  const candidate = chain[Math.max(0, chain.length - 1 - trustedHops)];
  return isIP(candidate) ? candidate : remote;
}

/** Build a matcher for CIDR ranges ("160.79.104.0/21", "2001:db8::/32", "10.0.0.5"). Empty list allows all. */
export function createIpAllowlist(cidrs: string[]): (ip: string) => boolean {
  if (cidrs.length === 0) return () => true;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefixText] = cidr.trim().split("/");
    const family = isIP(address);
    if (family === 0) throw new Error(`Invalid IP range "${cidr}" in http.ipAllowlist`);
    const max = family === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? max : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new Error(`Invalid prefix length in "${cidr}" (http.ipAllowlist)`);
    }
    list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return (ip: string) => {
    const value = normalizeIp(ip);
    const family = isIP(value);
    if (family === 4) return list.check(value, "ipv4");
    if (family === 6) return list.check(value, "ipv6");
    return false;
  };
}

export type TakeResult = { allowed: true } | { allowed: false; retryAfterSec: number };

/** Token bucket per key (principal id or client IP). Memory is bounded by `maxKeys` (oldest key evicted). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly perMs: number;

  constructor(
    private readonly opts: { capacity: number; refillPerMinute: number; now?: () => number; maxKeys?: number },
  ) {
    this.perMs = opts.refillPerMinute / 60_000;
  }

  take(key: string): TakeResult {
    const now = (this.opts.now ?? Date.now)();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.opts.capacity, updated: now };
      this.buckets.set(key, bucket);
      if (this.buckets.size > (this.opts.maxKeys ?? 10_000)) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }
    bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + (now - bucket.updated) * this.perMs);
    bucket.updated = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / this.perMs / 1000)) };
  }
}

/** Response headers for an API that is never rendered by a browser. */
export function withSecurityHeaders(response: Response, opts: { hsts: boolean }): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (opts.hsts) headers.set("Strict-Transport-Security", "max-age=31536000");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
