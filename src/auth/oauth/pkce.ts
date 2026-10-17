import { createHash, randomBytes } from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 S256 code challenge for a verifier. */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32)); // 43 characters, within RFC 7636's 43–128
  return { verifier, challenge: challengeFor(verifier) };
}

/** Unguessable value binding the redirect to this sign-in attempt (CSRF protection). */
export function randomState(): string {
  return base64url(randomBytes(24));
}
