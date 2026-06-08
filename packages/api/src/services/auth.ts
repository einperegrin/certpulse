/**
 * API token utilities.
 *
 * Tokens are 30 random bytes encoded as base64url — that's 40 chars, long
 * enough to be unguessable in practice (192 bits of entropy). The raw token
 * is shown to the operator exactly once at creation time; the database only
 * stores its SHA-256 hash.
 *
 * Verification uses Node's timingSafeEqual to defeat timing side-channels
 * that would otherwise let an attacker binary-search the hash byte-by-byte.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 30; // 30 bytes -> 40 base64url chars

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyToken(token: string, expectedHash: string): boolean {
  const actual = hashToken(token);
  // timingSafeEqual requires equal-length buffers
  if (actual.length !== expectedHash.length) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expectedHash, "hex"));
}
