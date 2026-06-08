import { describe, it, expect } from "vitest";
import { generateToken, hashToken, verifyToken } from "./auth.js";

describe("auth", () => {
  it("generateToken returns a 40-char base64url string", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("generateToken returns unique values", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });

  it("hashToken is deterministic and returns 64-char hex", () => {
    const h = hashToken("test-token-123");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("test-token-123")).toBe(h);
  });

  it("verifyToken returns true for matching token, false otherwise", () => {
    const t = generateToken();
    const h = hashToken(t);
    expect(verifyToken(t, h)).toBe(true);
    expect(verifyToken("wrong", h)).toBe(false);
  });

  it("verifyToken returns false for length-mismatched hash", () => {
    // No throw, no false-positive: even a short hash is rejected.
    expect(verifyToken("anything", "abc")).toBe(false);
  });
});
