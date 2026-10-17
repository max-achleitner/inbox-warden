import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../audit/canonical.js";

/** Per-process key; confirmation rounds never outlive the server process. */
const SECRET = randomBytes(32);
const TTL_MS = 15 * 60 * 1000;

/** SHA-256 over the canonical JSON of exactly what will be sent. */
export function operationDigest(parts: unknown): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

function mac(payload: string): Buffer {
  return createHmac("sha256", SECRET).update(payload).digest();
}

/** Nonces of redeemed confirmations → their expiry; pruned as they expire. */
const redeemed = new Map<string, number>();

/** Opaque, integrity-protected requestState binding a confirmation to one operation digest. */
export function mintConfirmationState(digest: string, now: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ d: digest, e: now + TTL_MS, n: randomBytes(16).toString("base64url") })).toString("base64url");
  return `${payload}.${mac(payload).toString("base64url")}`;
}

function readState(state: string, digest: string, now: number): { nonce?: string; expiresAt: number } | null {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;
  const expected = mac(payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { d, e, n } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { d?: unknown; e?: unknown; n?: unknown };
    if (d !== digest || typeof e !== "number" || now > e) return null;
    return { nonce: typeof n === "string" ? n : undefined, expiresAt: e };
  } catch {
    return null;
  }
}

export function verifyConfirmationState(state: string, digest: string, now: number = Date.now()): boolean {
  return readState(state, digest, now) !== null;
}

/**
 * verifyConfirmationState() that also uses the confirmation up: a retried request carrying the
 * same answer (e.g. after a client timeout) cannot perform the operation a second time.
 */
export function redeemConfirmationState(state: string, digest: string, now: number = Date.now()): boolean {
  for (const [nonce, expiresAt] of redeemed) if (now > expiresAt) redeemed.delete(nonce);
  const valid = readState(state, digest, now);
  if (!valid?.nonce || redeemed.has(valid.nonce)) return false;
  redeemed.set(valid.nonce, valid.expiresAt);
  return true;
}
