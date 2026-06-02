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
    expect(r.rawPem).toContain("BEGIN CERTIFICATE");
  }, 15000);

  it("returns days_remaining <= 0 for an expired cert", async () => {
    const r = await checkSSL("localhost", expiredServer.port, {
      timeoutMs: 5000,
      rejectUnauthorized: false,
    });
    expect(r.error).toBeNull();
    expect(r.daysRemaining).not.toBeNull();
    expect(r.daysRemaining ?? 999).toBeLessThanOrEqual(0);
  }, 15000);

  it("returns an error for an unreachable host/port", async () => {
    const r = await checkSSL("localhost", 1, { timeoutMs: 2000 });
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.daysRemaining).toBeNull();
  }, 10000);
});
