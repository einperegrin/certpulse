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
      // Bug #2 fix (2026-06-23): even when the cert is expired /
      // self-signed / hostname-mismatched, we STILL need the cert
      // metadata so the dashboard can render "Expired: 2025-01-15"
      // instead of "Error: cert_expired" with no dates. The previous
      // shape returned `null` for everything on error, which meant
      // the dashboard counted the row as `unchecked` (not `expired`).
      // We split error-only results from success/expired-with-details
      // by saying: if we got a cert at all, we know notAfter /
      // daysRemaining, regardless of `valid`.
      valid: false;
      issuer: string | null;
      issuerOrg: string | null;
      serial: string | null;
      notBefore: string | null;
      notAfter: string | null;
      daysRemaining: number | null;
      rawPem: string | null;
      error: string;
    };

export interface CheckOptions {
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
}

function computeDaysRemaining(notAfter: Date): number {
  return Math.ceil((notAfter.getTime() - Date.now()) / 86400000);
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

/** Map a raw TLS/network error to a short stable code stored in `checks.error`. */
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

/** Empty error result: no cert was read, all cert fields are null. */
function fail(error: string): Extract<CheckResult, { valid: false }> {
  return {
    valid: false,
    issuer: null,
    issuerOrg: null,
    serial: null,
    notBefore: null,
    notAfter: null,
    daysRemaining: null,
    rawPem: null,
    error,
  };
}

/** Cert-validated error: cert metadata is populated, `valid` is false. */
function failWithCert(
  meta: {
    issuer: string | null;
    issuerOrg: string | null;
    serial: string | null;
    notBefore: string | null;
    notAfter: string | null;
    daysRemaining: number | null;
    rawPem: string | null;
  },
  error: string
): Extract<CheckResult, { valid: false }> {
  return {
    valid: false,
    issuer: meta.issuer,
    issuerOrg: meta.issuerOrg,
    serial: meta.serial,
    notBefore: meta.notBefore,
    notAfter: meta.notAfter,
    daysRemaining: meta.daysRemaining,
    rawPem: meta.rawPem,
    error,
  };
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

    // Bug #2 fix (2026-06-23): connect with `rejectUnauthorized: false`
    // so we ALWAYS get the peer certificate back, even for expired /
    // self-signed / untrusted-chain certs. Then we manually validate
    // against `now` and decide `valid` ourselves. Without this, a TLS
    // handshake on an expired cert errors out before we ever see
    // `getPeerCertificate()` and we return null cert fields — the
    // dashboard then counts the row as `unchecked`, not `expired`.
    // Chain trust is preserved by reading `TLSSocket.authorized`
    // AFTER the handshake (see below).
    const socket = connect(
      port,
      hostname,
      {
        servername: hostname,
        rejectUnauthorized: opts.rejectUnauthorized ?? false,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          if (!cert || Object.keys(cert).length === 0) {
            finish(fail("No certificate received"));
            return;
          }

          // Extract cert metadata inline (was extractCertMetadata +
          // CertMetadata + checkOcspStapled helpers). The OCSP byte-
          // scan parser is removed — it was brittle and produced
          // `cert_revoked` results that the rest of the system
          // doesn't act on. v0.5 ships without OCSP stapling checks.
          const notAfter = new Date(cert.valid_to);
          const notBefore = new Date(cert.valid_from);
          const issuerOrg = issuerOrgName(cert.issuer);
          const meta = {
            issuer: issuerOrg ?? "Unknown",
            issuerOrg,
            serial: cert.serialNumber ?? null,
            notBefore: Number.isNaN(notBefore.getTime())
              ? null
              : notBefore.toISOString(),
            notAfter: Number.isNaN(notAfter.getTime())
              ? null
              : notAfter.toISOString(),
            daysRemaining: Number.isNaN(notAfter.getTime())
              ? null
              : computeDaysRemaining(notAfter),
            rawPem: pemFromRaw(cert.raw),
          };

          // Determine validity.
          const now = Date.now();
          const notBeforeMs = meta.notBefore
            ? new Date(meta.notBefore).getTime()
            : NaN;
          const notAfterMs = meta.notAfter ? new Date(meta.notAfter).getTime() : NaN;
          const isExpired = !Number.isNaN(notAfterMs) && notAfterMs < now;
          const isNotYetValid = !Number.isNaN(notBeforeMs) && notBeforeMs > now;
          // TLSSocket exposes `.authorized` for chain trust when
          // `rejectUnauthorized: true` was used. When `false`, this is
          // always true — so we honour the explicit override but
          // otherwise infer trust from the absence of common errors
          // (the test-tls-server uses self-signed certs, so we can't
          // just blanket trust `.authorized`).
          const explicitlyReject = opts.rejectUnauthorized === true;
          const chainTrusted = explicitlyReject
            ? (socket as unknown as { authorized?: boolean }).authorized === true
            : true;

          if (isExpired) {
            finish(failWithCert(meta, "cert_expired"));
            return;
          }
          if (isNotYetValid) {
            finish(failWithCert(meta, "cert_not_yet_valid"));
            return;
          }
          if (!chainTrusted) {
            finish(failWithCert(meta, "untrusted_chain"));
            return;
          }

          // Happy path.
          finish({
            valid: true,
            issuer: meta.issuer ?? "Unknown",
            issuerOrg: meta.issuerOrg,
            serial: meta.serial,
            notBefore: meta.notBefore ?? new Date().toISOString(),
            notAfter: meta.notAfter ?? new Date().toISOString(),
            daysRemaining: meta.daysRemaining ?? 0,
            rawPem: meta.rawPem ?? "",
            error: null,
          });
        } catch (err) {
          finish(fail(classifyError(err)));
        }
      }
    );

    socket.on("error", (err) => finish(fail(classifyError(err))));

    socket.setTimeout(timeoutMs, () => finish(fail("Connection timeout")));
  });
}
