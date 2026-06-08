/**
 * SSRF guard tests. Closes C-2 from the v0.2 hardening plan.
 *
 * The guard rejects hostnames that resolve to (or ARE) private/loopback/
 * link-local addresses. This is the single chokepoint before CertPulse
 * opens a TLS connection, so DNS-rebinding and cloud-metadata attacks
 * have to pass through here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPrivateAddress } from "./ssrf-guard.js";

describe("ssrf-guard — IPv4 private ranges", () => {
  // Hostname that does not require DNS resolution — we test pure IP inputs.
  it.each([
    "127.0.0.1",          // loopback
    "127.1.2.3",          // loopback short form
    "10.0.0.1",           // RFC1918
    "10.255.255.255",
    "172.16.0.1",         // RFC1918 lower bound
    "172.31.255.255",     // RFC1918 upper bound
    "192.168.0.1",        // RFC1918
    "169.254.169.254",    // AWS/GCP metadata link-local
    "0.0.0.0",            // unspecified
    "100.64.0.1",         // CGNAT
    "192.0.2.1",          // TEST-NET-1
    "198.18.0.1",         // benchmarking
    "198.51.100.1",       // TEST-NET-2
    "203.0.113.1",        // TEST-NET-3
    "224.0.0.1",          // multicast
    "240.0.0.1",          // reserved
    "255.255.255.255",    // broadcast
  ])("blocks %s", async (ip) => {
    expect(await isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "9.9.9.9",
    "172.32.0.1",          // JUST outside RFC1918
    "172.15.255.255",      // JUST outside RFC1918
    "11.0.0.1",            // JUST outside 10.0.0.0/8
    "192.169.0.1",         // JUST outside 192.168.0.0/16
    "100.63.255.255",      // JUST outside CGNAT
    "169.255.0.0",         // JUST outside link-local
  ])("allows public %s", async (ip) => {
    expect(await isPrivateAddress(ip)).toBe(false);
  });
});

describe("ssrf-guard — IPv6", () => {
  it.each([
    "::1",           // loopback
    "::",            // unspecified
    "fe80::1",       // link-local
    "fe90::1",       // link-local (alternate prefix)
    "fec0::1",       // site-local (deprecated but private)
    "fc00::1",       // unique local
    "fd00::1",       // unique local
    "ff00::1",       // multicast
  ])("blocks %s", async (ip) => {
    expect(await isPrivateAddress(ip)).toBe(true);
  });

  it("allows a public IPv6 (2001:4860:4860::8888 = Google DNS)", async () => {
    expect(await isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });
});

describe("ssrf-guard — hostname resolution", () => {
  // DNS-based checks. We do not mock node:dns because we are testing real
  // behaviour against the runtime. localhost and *.localhost are reserved
  // names and should resolve to loopback (RFC 6761) on any conforming
  // resolver.
  it("blocks localhost", async () => {
    expect(await isPrivateAddress("localhost")).toBe(true);
  });

  it("blocks a hostname that does not resolve (treats NXDOMAIN as unsafe)", async () => {
    expect(
      await isPrivateAddress("nx.example.invalid")
    ).toBe(true);
  });

  // The DNS-rebinding test below is opt-in: it depends on the test
  // environment having a /etc/hosts entry that points `rebinding-test.invalid`
  // to 127.0.0.1. Skip by default so CI doesn't flap.
  const hasRebinding = process.env.SSRF_NETWORK_TEST === "1";
  (hasRebinding ? it : it.skip)(
    "blocks a hostname that resolves to a private IP (DNS-rebinding-style)",
    async () => {
      expect(
        await isPrivateAddress("rebinding-test.invalid")
      ).toBe(true);
    }
  );
});

describe("ssrf-guard — input validation", () => {
  it("blocks empty string", async () => {
    expect(await isPrivateAddress("")).toBe(true);
  });
});
