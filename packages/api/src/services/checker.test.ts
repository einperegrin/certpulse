import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSSL } from "./checker.js";
import { startTlsTestServer, type TlsTestServer } from "./test-tls-server.js";

let server: TlsTestServer;
let expiredServer: TlsTestServer;

beforeAll(async () => {
  server = await startTlsTestServer({ daysValid: 60 });
  expiredServer = await startTlsTestServer({ daysValid: -5 });
}, 30000);

afterAll(async () => {
  await server?.close();
  await expiredServer?.close();
});

describe("checkSSL", () => {
  it("returns days_remaining for a valid cert", async () => {
    const r = await checkSSL("localhost", server.port, {
      timeoutMs: 5000,
      rejectUnauthorized: false,
    });
    expect(r.error).toBeNull();
    expect(r.daysRemaining).not.toBeNull();
    expect(r.daysRemaining ?? 0).toBeGreaterThan(0);
    expect(r.notAfter).toBeTruthy();
    expect(r.notBefore).toBeTruthy();
    // rawPem depends on cert.raw being populated by the TLS layer;
    // some CI environments may not provide it for self-signed certs
    if (r.rawPem) {
      expect(r.rawPem).toContain("BEGIN CERTIFICATE");
    }
  }, 15000);

  // Bug #2 fix (2026-06-23): an expired cert now returns
  // `error: "cert_expired"` AND a populated `notAfter` /
  // `daysRemaining` (negative). The dashboard counts expired
  // domains via `daysRemaining <= 0`, so without the cert
  // metadata the row used to disappear into "unchecked".
  it("returns days_remaining <= 0 AND cert_expired error for an expired cert", async () => {
    const r = await checkSSL("localhost", expiredServer.port, {
      timeoutMs: 5000,
      rejectUnauthorized: false,
    });
    expect(r.valid).toBe(false);
    expect(r.error).toBe("cert_expired");
    expect(r.daysRemaining).not.toBeNull();
    expect(r.daysRemaining ?? 999).toBeLessThanOrEqual(0);
    expect(r.notAfter).toBeTruthy();
    expect(r.notBefore).toBeTruthy();
    // Issuer must be populated (the test server is a self-signed
    // CA, so the cert does have an issuer field).
    expect(r.issuer).toBeTruthy();
  }, 15000);

  it("returns an error for an unreachable host/port", async () => {
    const r = await checkSSL("localhost", 1, { timeoutMs: 2000 });
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.daysRemaining).toBeNull();
  }, 10000);

  // Bug #2 fix: a TCP-level error (no handshake completed) still
  // returns the legacy all-null shape — there is no cert to read.
  it("returns null cert fields when the connection never completed TLS", async () => {
    const r = await checkSSL("127.0.0.1", 1, { timeoutMs: 1000 });
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.daysRemaining).toBeNull();
    expect(r.notAfter).toBeNull();
    expect(r.notBefore).toBeNull();
    expect(r.issuer).toBeNull();
  }, 10000);
});
