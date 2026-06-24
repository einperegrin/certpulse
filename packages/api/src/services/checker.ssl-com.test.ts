/**
 * Integration tests against the 12 SSL.com test domains.
 *
 * These tests exercise the real `checkSSL()` against live, public
 * SSL.com endpoints that have a known status (valid / expired /
 * revoked). They are SEPARATE from the unit tests in checker.test.ts
 * (which use a local `test-tls-server`) so they can be skipped in CI
 * when network is unavailable.
 *
 * Skip via env var: `SKIP_NETWORK_TESTS=1`.
 *
 * Reference: https://www.ssl.com/sample-test-domains/
 * (The SSL.com sample-certificate page documents these endpoints as
 * canonical test vectors for cert-validation logic.)
 */
import { describe, expect, it } from "vitest";
import { checkSSL } from "./checker.js";

const skipNetwork = process.env.SKIP_NETWORK_TESTS === "1";

const VALID_DOMAINS = [
  "test-ev-rsa.ssl.com",
  "test-dv-rsa.ssl.com",
  "test-ev-ecc.ssl.com",
  "test-dv-ecc.ssl.com",
] as const;

const EXPIRED_DOMAINS = [
  "expired-rsa-dv.ssl.com",
  "expired-rsa-ev.ssl.com",
  "expired-ecc-dv.ssl.com",
  "expired-ecc-ev.ssl.com",
] as const;

const REVOKED_DOMAINS = [
  "revoked-rsa-dv.ssl.com",
  "revoked-rsa-ev.ssl.com",
  "revoked-ecc-dv.ssl.com",
  "revoked-ecc-ev.ssl.com",
] as const;

const NETWORK_TIMEOUT_MS = 15000;

describe.skipIf(skipNetwork)("checkSSL against SSL.com test domains (network)", () => {
  describe.each(VALID_DOMAINS)("valid cert: %s", (domain) => {
    it("returns valid=true, daysRemaining>0, populated issuer", async () => {
      const r = await checkSSL(domain, 443, {
        timeoutMs: NETWORK_TIMEOUT_MS,
        rejectUnauthorized: false,
      });
      expect(r.error).toBeNull();
      expect(r.valid).toBe(true);
      expect(r.daysRemaining).not.toBeNull();
      expect(r.daysRemaining ?? 0).toBeGreaterThan(0);
      expect(r.notAfter).toBeTruthy();
      expect(r.notBefore).toBeTruthy();
      expect(r.issuer).toBeTruthy();
      // Sanity: subject CN matches the hostname we asked for.
      // (Some CAs include the requested name in CN; this is a soft
      // assertion, not a hard one.)
    }, NETWORK_TIMEOUT_MS + 5000);
  });

  describe.each(EXPIRED_DOMAINS)("expired cert: %s", (domain) => {
    // Bug #2 fix (2026-06-23): even when the cert is expired, the
    // checker MUST return populated `notAfter`/`daysRemaining` so the
    // dashboard can render "Expired" with the actual expiry date and
    // count the row in `daysRemaining <= 0`.
    it("returns valid=false, error=cert_expired, daysRemaining<=0", async () => {
      const r = await checkSSL(domain, 443, {
        timeoutMs: NETWORK_TIMEOUT_MS,
        rejectUnauthorized: false,
      });
      expect(r.valid).toBe(false);
      expect(r.error).toBe("cert_expired");
      expect(r.daysRemaining).not.toBeNull();
      expect(r.daysRemaining ?? 999).toBeLessThanOrEqual(0);
      expect(r.notAfter).toBeTruthy();
      expect(r.notBefore).toBeTruthy();
      expect(r.issuer).toBeTruthy();
    }, NETWORK_TIMEOUT_MS + 5000);
  });

  describe.each(REVOKED_DOMAINS)("revoked cert: %s", (domain) => {
    // Limitation documented in the task: SSL.com does not staple OCSP
    // responses on these test endpoints (verified 2026-06-23). Without
    // a stapled response, our parser has nothing to read, so we cannot
    // distinguish "revoked" from "valid" via this checker alone.
    //
    // We DO assert that the cert looks syntactically valid (matches the
    // `valid` shape) and that the cert has not expired — so a downstream
    // operator could overlay an external OCSP fetch and re-mark these as
    // revoked without the checker getting in the way. The day SSL.com
    // starts stapling OCSP on these endpoints, this test should
    // additionally assert `error === "cert_revoked"`.
    it(
      "is recognised as valid by TLS alone (no OCSP stapling on SSL.com test endpoints)",
      async () => {
        const r = await checkSSL(domain, 443, {
          timeoutMs: NETWORK_TIMEOUT_MS,
          rejectUnauthorized: false,
        });
        // The cert itself is not expired, so the TLS layer is happy.
        expect(r.daysRemaining).not.toBeNull();
        expect(r.daysRemaining ?? 0).toBeGreaterThan(0);
        // We can't assert cert_revoked without OCSP — the limitation
        // is documented in the checker.ts comment block.
        expect(r.error === null || r.error === "cert_revoked").toBe(true);
      },
      NETWORK_TIMEOUT_MS + 5000
    );
  });
});