/**
 * Domain expiry (RDAP) lookup.
 *
 * RDAP (Registration Data Access Protocol) is the modern, structured successor
 * to WHOIS — HTTPS-based with JSON responses. We hit the IANA bootstrap to
 * discover the authoritative server for the TLD, then query it for the
 * domain. If RDAP isn't available (some ccTLDs still don't have it), we
 * fall back to a TCP WHOIS query against the IANA-referred server.
 *
 * No external dependencies — only Node's built-in `fetch` (Node 18+) and `net` modules.
 */

import { createConnection } from "node:net";

export interface DomainExpiryResult {
  expiresAt: string | null; // ISO 8601
  daysRemaining: number | null;
  registrar: string | null;
  error: string | null;
}

interface RdapBootstrap {
  services: Array<[string[], string[]]>; // [[tlds], [rdapEndpoints]]
}

const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const WHOIS_PORT = 43;
const WHOIS_TIMEOUT_MS = 8000;
const RDAP_TIMEOUT_MS = 8000;

let _bootstrapCache: { fetchedAt: number; data: RdapBootstrap } | null = null;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

function tldOf(hostname: string): string {
  const parts = hostname.toLowerCase().split(".");
  return parts[parts.length - 1] ?? "";
}

async function fetchBootstrap(): Promise<RdapBootstrap | null> {
  if (_bootstrapCache && Date.now() - _bootstrapCache.fetchedAt < BOOTSTRAP_TTL_MS) {
    return _bootstrapCache.data;
  }
  try {
    const res = await fetchWithTimeout(RDAP_BOOTSTRAP_URL, RDAP_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = (await res.json()) as RdapBootstrap;
    _bootstrapCache = { fetchedAt: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    fetch(url, { signal: ac.signal })
      .then((r) => {
        clearTimeout(timer);
        resolve(r);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

function rdapEndpointFor(tld: string, bootstrap: RdapBootstrap): string | null {
  for (const [tlds, endpoints] of bootstrap.services) {
    if (tlds.includes(tld)) return endpoints[0] ?? null;
  }
  return null;
}

function computeDaysRemaining(expiresAt: string): number | null {
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return null;
  const diff = d.getTime() - Date.now();
  return Math.ceil(diff / 86400000);
}

interface RdapDomainResponse {
  events?: Array<{ eventAction?: string; eventDate?: string }>;
  entities?: Array<{
    // RFC 7483 §5.1: roles is an array. Some servers still emit a singular
    // `role` string for back-compat, so accept both.
    role?: string;
    roles?: string[];
    vcardArray?: [
      string,
      Array<Array<string | Record<string, string> | string[]>> | undefined,
    ];
  }>;
  status?: string[];
}

function extractRegistrar(rdap: RdapDomainResponse): string | null {
  if (!Array.isArray(rdap.entities)) return null;
  for (const e of rdap.entities) {
    // Per RFC 7483 §5.1, RDAP entity objects expose `roles` as an array
    // (e.g. ["registrar", "sponsor"]). Some servers may still emit the
    // singular `role` for back-compat, so check both.
    const roles: string[] = Array.isArray(e.roles)
      ? e.roles
      : typeof e.role === "string"
        ? [e.role]
        : [];
    if (!roles.includes("registrar")) continue;
    const vcard = e.vcardArray?.[1];
    if (!Array.isArray(vcard)) continue;
    for (const entry of vcard) {
      if (!Array.isArray(entry)) continue;
      const field = entry[0];
      const value = entry[3];
      if (field === "fn" && typeof value === "string") return value;
    }
  }
  return null;
}

function extractExpiry(rdap: RdapDomainResponse): string | null {
  if (!Array.isArray(rdap.events)) return null;
  for (const ev of rdap.events) {
    if (ev.eventAction === "expiration" && ev.eventDate) return ev.eventDate;
  }
  return null;
}

async function lookupRdap(hostname: string): Promise<DomainExpiryResult> {
  const bootstrap = await fetchBootstrap();
  if (!bootstrap) {
    return { expiresAt: null, daysRemaining: null, registrar: null, error: "RDAP bootstrap unavailable" };
  }
  const tld = tldOf(hostname);
  const endpoint = rdapEndpointFor(tld, bootstrap);
  if (!endpoint) {
    return { expiresAt: null, daysRemaining: null, registrar: null, error: `No RDAP server for .${tld}` };
  }
  try {
    const url = `${endpoint.replace(/\/$/, "")}/domain/${encodeURIComponent(hostname)}`;
    const res = await fetchWithTimeout(url, RDAP_TIMEOUT_MS);
    if (res.status === 404) {
      return { expiresAt: null, daysRemaining: null, registrar: null, error: "Domain not found in RDAP" };
    }
    if (!res.ok) {
      return { expiresAt: null, daysRemaining: null, registrar: null, error: `RDAP HTTP ${res.status}` };
    }
    const data = (await res.json()) as RdapDomainResponse;
    const expiresAt = extractExpiry(data);
    const registrar = extractRegistrar(data);
    if (!expiresAt) {
      return { expiresAt: null, daysRemaining: null, registrar, error: "No expiry event in RDAP response" };
    }
    return {
      expiresAt,
      daysRemaining: computeDaysRemaining(expiresAt),
      registrar,
      error: null,
    };
  } catch (err) {
    return {
      expiresAt: null,
      daysRemaining: null,
      registrar: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function queryWhoisServer(server: string, query: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: server, port: WHOIS_PORT });
    let buffer = "";
    let settled = false;
    const finish = (err: Error | null, data?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(data ?? "");
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("WHOIS timeout")));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
    });
    socket.on("error", (err: Error) => finish(err));
    socket.on("end", () => finish(null, buffer));
    socket.write(`${query}\r\n`);
  });
}

export function extractWhoisExpiry(text: string): { expiresAt: string | null; registrar: string | null } {
  // Permissive pattern: many registrars use different field names for the
  // expiry date. We try the most common variants in order; first parseable
  // match wins.
  const expiryPatterns: RegExp[] = [
    /(?:registry expiry date|registrar registration expiration date|expires on|expiration date|expiry date|paid-till|expires)\s*[:=]\s*([0-9T:\-\.Z+\s]+)/i,
  ];
  const registrarPatterns: RegExp[] = [
    /registrar\s*[:=]\s*([^\r\n]+)/i,
    /sponsoring registrar\s*[:=]\s*([^\r\n]+)/i,
  ];
  let expiresAt: string | null = null;
  let registrar: string | null = null;
  for (const p of expiryPatterns) {
    const m = text.match(p);
    if (m?.[1]) {
      const candidate = m[1].trim();
      const d = new Date(candidate);
      if (!Number.isNaN(d.getTime())) {
        expiresAt = d.toISOString();
        break;
      }
    }
  }
  for (const p of registrarPatterns) {
    const m = text.match(p);
    if (m?.[1]) {
      registrar = m[1].trim();
      break;
    }
  }
  return { expiresAt, registrar };
}

async function lookupWhoisFallback(hostname: string): Promise<DomainExpiryResult> {
  // IANA WHOIS server. Querying it with the TLD (e.g. "com") returns the
  // authoritative whois server for that TLD. Querying with a full hostname
  // like "example.com" usually yields no useful referral.
  const tld = tldOf(hostname);
  if (!tld) {
    return { expiresAt: null, daysRemaining: null, registrar: null, error: "No TLD" };
  }
  try {
    const referral = await queryWhoisServer("whois.iana.org", tld, WHOIS_TIMEOUT_MS);
    const referMatch = referral.match(/(?:refer|whois)\s*[:=]\s*([a-z0-9.-]+\.[a-z]{2,})/i);
    const whoisServer = referMatch?.[1] ?? "whois.iana.org";
    const response = await queryWhoisServer(whoisServer, hostname, WHOIS_TIMEOUT_MS);
    const { expiresAt, registrar } = extractWhoisExpiry(response);
    if (!expiresAt) {
      return { expiresAt: null, daysRemaining: null, registrar, error: "No expiry found in WHOIS" };
    }
    return {
      expiresAt,
      daysRemaining: computeDaysRemaining(expiresAt),
      registrar,
      error: null,
    };
  } catch (err) {
    return {
      expiresAt: null,
      daysRemaining: null,
      registrar: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve a domain's registration expiry. RDAP first, plain WHOIS fallback.
 * Always returns a result — failures populate `error` rather than throwing.
 */
export async function lookupDomainExpiry(hostname: string): Promise<DomainExpiryResult> {
  const rdap = await lookupRdap(hostname);
  if (rdap.expiresAt) return rdap;
  const whois = await lookupWhoisFallback(hostname);
  if (whois.expiresAt) return whois;
  return {
    expiresAt: rdap.expiresAt ?? whois.expiresAt,
    daysRemaining: null,
    registrar: rdap.registrar ?? whois.registrar,
    error: rdap.error && whois.error
      ? `RDAP: ${rdap.error}; WHOIS: ${whois.error}`
      : rdap.error ?? whois.error ?? "unknown",
  };
}
