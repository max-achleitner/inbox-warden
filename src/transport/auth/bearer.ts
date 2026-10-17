import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface BearerTokenEntry {
  id: string;
  /** Lowercase hex SHA-256 of the token. The token itself is never stored. */
  sha256: string;
}

export const TOKEN_PREFIX = "imcp_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 256 bits of randomness, URL-safe, recognisable prefix for secret scanners. */
export function generateBearerToken(): { token: string; sha256: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, sha256: hashToken(token) };
}

/** Extract the token from an `Authorization: Bearer <token>` header (RFC 6750 b64token syntax). */
export function parseBearerHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * Compare the presented token's digest with every configured digest in constant time.
 * All entries are always checked so the response time does not reveal which entry matched.
 */
export function matchBearerToken(presented: string, entries: BearerTokenEntry[]): string | null {
  const digest = Buffer.from(hashToken(presented), "hex");
  let matched: string | null = null;
  for (const entry of entries) {
    const expected = Buffer.from(entry.sha256, "hex");
    const equal = expected.length === digest.length && timingSafeEqual(expected, digest);
    if (equal && matched === null) matched = entry.id;
  }
  return matched;
}
