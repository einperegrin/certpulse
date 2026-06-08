/**
 * SSRF guard. Closes C-2 from the v0.2 hardening plan.
 *
 * A hostname is rejected (treated as private/unsafe) if it IS, or resolves
 * to, an address in a private/loopback/link-local range. We check ALL
 * addresses returned by DNS — a single public address does NOT make a
 * hostname safe, because attackers can serve mixed DNS answers (the
 * classic DNS-rebinding setup).
 *
 * IMPORTANT: this guard runs at request time AND before every TCP connect
 * performed by the checker. A hostname that was public when added may
 * become private later, so the checker should call this too.
 */
import { lookup } from "node:dns/promises";

/** IPv4 prefixes and the mask that defines the range. The mask is informational. */
const IPV4_PRIVATE_PREFIXES: readonly RegExp[] = [
  /^10\./,                                  // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,             // 172.16.0.0/12
  /^192\.168\./,                            // 192.168.0.0/16
  /^127\./,                                 // 127.0.0.0/8 loopback
  /^169\.254\./,                            // 169.254.0.0/16 link-local — cloud metadata!
  /^0\./,                                   // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^192\.0\.0\./,                           // 192.0.0.0/24 IETF protocol
  /^192\.0\.2\./,                           // TEST-NET-1
  /^198\.18\./,                             // 198.18.0.0/15 benchmarking
  /^198\.51\.100\./,                        // TEST-NET-2
  /^203\.0\.113\./,                         // TEST-NET-3
  /^22[4-9]\./,                             // 224.0.0.0/4 multicast (224-239)
  /^23[0-9]\./,                             // 224.0.0.0/4 multicast
  /^24[0-9]\./,                             // 240.0.0.0/4 reserved (240-255)
  /^25[0-5]\./,                             // 240.0.0.0/4 reserved
];

function isPrivateIPv4(ip: string): boolean {
  for (const re of IPV4_PRIVATE_PREFIXES) {
    if (re.test(ip)) return true;
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().split("%")[0]!; // strip zone-id if any
  if (lower === "::1") return true;            // loopback
  if (lower === "::") return true;             // unspecified
  // fe80::/10 link-local (covers fe80, fe90, fea0, feb0)
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  // fec0::/10 site-local (deprecated but still routed nowhere public)
  if (
    lower.startsWith("fec") ||
    lower.startsWith("fed") ||
    lower.startsWith("fee") ||
    lower.startsWith("fef")
  ) {
    return true;
  }
  // fc00::/7 unique local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // ff00::/8 multicast
  if (lower.startsWith("ff")) return true;
  return false;
}

/**
 * Check if `host` is a private/loopback/link-local address.
 *
 * Behaviour:
 * - Pure IP literal: checked directly against the prefix tables.
 * - Hostname: resolved with node:dns. ALL returned addresses are checked;
 *   if any is private, the hostname is considered unsafe. This is what
 *   defeats DNS-rebinding-style attacks where a public name briefly
 *   resolves to a private IP.
 * - Resolution failure (NXDOMAIN, timeout) is treated as UNSAFE — we do
 *   not let an attacker crash the check by serving broken DNS, and we
 *   would rather reject a typo than open a connection to nothing.
 * - Empty string is unsafe.
 */
export async function isPrivateAddress(host: string): Promise<boolean> {
  if (!host) return true;

  // IPv4 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isPrivateIPv4(host);
  }

  // IPv6 literal (optionally bracketed — we strip brackets defensively)
  if (host.includes(":")) {
    const stripped = host.replace(/^\[|\]$/g, "");
    return isPrivateIPv6(stripped);
  }

  // Hostname: resolve and check every answer.
  try {
    const result = await lookup(host, { all: true });
    if (result.length === 0) return true;
    for (const addr of result) {
      if (addr.family === 4 && isPrivateIPv4(addr.address)) return true;
      if (addr.family === 6 && isPrivateIPv6(addr.address)) return true;
    }
    return false;
  } catch {
    // DNS failure — treat as unsafe. Logging is left to the caller.
    return true;
  }
}
