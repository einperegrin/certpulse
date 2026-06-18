import { connect, type PeerCertificate } from "node:tls";

export type CheckResult =
  | {
      valid: boolean;
      issuer: string;
      issuerOrg: string | null;
      serial: string | null;
      notBefore: string;
      notAfter: string;
      daysRemaining: number;
      rawPem: string;
      error: null;
    }
  | {
      valid: false;
      issuer: null;
      issuerOrg: null;
      serial: null;
      notBefore: null;
      notAfter: null;
      daysRemaining: null;
      rawPem: null;
      error: string;
    };

export interface CheckOptions {
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
}

function computeDaysRemaining(notAfter: Date): number {
  const diffMs = notAfter.getTime() - Date.now();
  return Math.ceil(diffMs / 86400000);
}

function issuerOrgName(issuer: PeerCertificate["issuer"]): string | null {
  if (!issuer) return null;
  const obj = issuer as Record<string, unknown>;
  const org = (obj.O ?? obj.OU ?? obj.CN) as string | undefined;
  return typeof org === "string" ? org : null;
}

function pemFromRaw(raw: Buffer | undefined): string {
  if (!raw || !Buffer.isBuffer(raw) || raw.length === 0) return "";
  const b64 = raw.toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

/**
 * Map a raw TLS/network error to a short stable code stored in the
 * `checks.error` column. The full error is logged server-side; the
 * API client never sees libuv/TLS internals (e.g. `getaddrinfo
 * ENOTFOUND …`, `TLS timeout`, `unable to verify the first
 * certificate`). (v0.4.1 code-review HIGH.)
 */
function classifyError(err: unknown): string {
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return "unknown";
  const e = err as { code?: string; message?: string };
  const code = typeof e.code === "string" ? e.code : "";
  const msg = typeof e.message === "string" ? e.message : "";
  if (code === "ENOTFOUND") return "dns_not_found";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "tls_timeout";
  if (code === "ECONNRESET") return "connection_reset";
  if (code === "CERT_HAS_EXPIRED") return "cert_expired";
  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN")
    return "self_signed";
  if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "untrusted_chain";
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "hostname_mismatch";
  // Fallback: short non-PII prefix of the message so the operator can
  // still diagnose from the dashboard without exposing internals.
  if (msg) return msg.split(/\s+/, 4).join("_").toLowerCase().replace(/[^a-z0-9_]/g, "");
  return "tls_error";
}

export function checkSSL(
  hostname: string,
  port = 443,
  opts: CheckOptions = {}
): Promise<CheckResult> {
  const timeoutMs = opts.timeoutMs ?? 10000;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const socket = connect(
      port,
      hostname,
      {
        servername: hostname,
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
      },
      () => {
      try {
        const cert = socket.getPeerCertificate(true);
        if (!cert || Object.keys(cert).length === 0) {
          finish({
            valid: false,
            issuer: null,
            issuerOrg: null,
            serial: null,
            notBefore: null,
            notAfter: null,
            daysRemaining: null,
            rawPem: null,
            error: "No certificate received",
          });
          return;
        }

        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        const notAfter = validTo;
        const notBefore = validFrom;

        if (Number.isNaN(notAfter.getTime())) {
          finish({
            valid: false,
            issuer: null,
            issuerOrg: null,
            serial: null,
            notBefore: null,
            notAfter: null,
            daysRemaining: null,
            rawPem: null,
            error: "Certificate has no valid expiry date",
          });
          return;
        }

        const issuerOrg = issuerOrgName(cert.issuer);
        finish({
          valid: true,
          issuer: issuerOrg ?? "Unknown",
          issuerOrg,
          serial: cert.serialNumber ?? null,
          notBefore: notBefore.toISOString(),
          notAfter: notAfter.toISOString(),
          daysRemaining: computeDaysRemaining(notAfter),
          rawPem: pemFromRaw(cert.raw),
          error: null,
        });
      } catch (err) {
        finish({
          valid: false,
          issuer: null,
          issuerOrg: null,
          serial: null,
          notBefore: null,
          notAfter: null,
          daysRemaining: null,
          rawPem: null,
          error: classifyError(err),
        });
      }
    });

    socket.on("error", (err) => {
      finish({
        valid: false,
        issuer: null,
        issuerOrg: null,
        serial: null,
        notBefore: null,
        notAfter: null,
        daysRemaining: null,
        rawPem: null,
        error: classifyError(err),
      });
    });

    socket.setTimeout(timeoutMs, () => {
      finish({
        valid: false,
        issuer: null,
        issuerOrg: null,
        serial: null,
        notBefore: null,
        notAfter: null,
        daysRemaining: null,
        rawPem: null,
        error: "Connection timeout",
      });
    });
  });
}
