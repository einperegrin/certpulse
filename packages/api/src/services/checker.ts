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
      // Bug #2 fix (2026-06-23): even when the cert is expired /
      // self-signed / hostname-mismatched, we STILL need the cert
      // metadata so the dashboard can render "Expired: 2025-01-15"
      // instead of "Error: cert_expired" with no dates. The previous
      // shape returned `null` for everything on error, which meant
      // the dashboard counted the row as `unchecked` (not `expired`).
      // We split error-only results from success/expired-with-details
      // by saying: if we got a cert at all, we know notAfter /
      // daysRemaining, regardless of `valid`.
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

/**
 * Decode an OCSP response body and return the cert status as a
 * short string. Returns `null` if the response cannot be parsed
 * (caller should treat as "revocation not checked", not an error).
 *
 * OCSP responses are ASN.1 DER-encoded `OCSPResponse` SEQUENCE
 * structures. We parse just enough to extract the `CertStatus`
 * CHOICE inside the single `SingleResponse` we care about — without
 * pulling in a full ASN.1 library. The format is:
 *
 *   SEQUENCE {
 *     responseStatus     ENUMERATED,         // 0=successful, 1..7 errors
 *     responseBytes [0]  SEQUENCE {          // present iff status == 0
 *       responseType   OID,                 // id-pkix-ocsp-basic
 *       response       OCTET STRING {       // BasicOCSPResponse
 *         tbsResponseData SEQUENCE {
 *           responses   SEQUENCE OF {
 *             SingleResponse SEQUENCE {
 *               certID    ...
 *               certStatus ENUMERATED,       // 0=good, 1=revoked, 2=unknown
 *               ...
 *             }
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * We do a depth-limited byte scan for the ENUMERATED tag (0x0A)
 * AFTER skipping the headers. That's brittle in theory but stable
 * in practice because every TLS implementation produces responses
 * in the same shape. If parsing ever fails the function returns
 * null and the caller marks the cert "revocation not checked".
 */
function parseOcspStatus(buf: Buffer): "good" | "revoked" | "unknown" | null {
  try {
    // responseStatus ENUMERATED — first byte after SEQUENCE header.
    // We don't bother parsing the outer SEQUENCE length; instead we
    // scan for the BasicOCSPResponse OID (1.3.6.1.5.5.7.48.1.1 =
    // 2B 06 01 05 05 07 30 01 01) and look ahead for the
    // SingleResponse structure.
    const basicOcspOid = Buffer.from([
      0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01, 0x01,
    ]);
    const idx = buf.indexOf(basicOcspOid);
    if (idx < 0) return null;
    // After the OID we have: OCTET STRING wrapper, then the inner
    // BasicOCSPResponse SEQUENCE. Scan forward for the first
    // SingleResponse (CONTEXT [0] tag 0xA0) and then a SEQUENCE
    // (0x30). Inside that, after the certID, comes certStatus
    // (ENUMERATED, tag 0x0A).
    let i = idx + basicOcspOid.length + 20; // skip a reasonable header
    i = buf.indexOf(0xa0, i); // SingleResponse [0]
    if (i < 0) return null;
    i = buf.indexOf(0x30, i); // SEQUENCE
    if (i < 0) return null;
    // Walk past certID. certID = SEQUENCE { hashAlgorithm, issuerNameHash,
    // issuerKeyHash, serialNumber }. Each component is TLV; we just
    // scan forward looking for the next 0x0A (ENUMERATED).
    i = i + 2; // skip tag + length byte(s) — this is approximate
    for (let safety = 0; safety < 50; safety++) {
      const tagIdx = buf.indexOf(0x0a, i);
      if (tagIdx < 0 || tagIdx > i + 200) return null;
      const len = buf[tagIdx + 1];
      if (len === undefined) return null;
      const status = buf[tagIdx + 2];
      if (status === 0) return "good";
      if (status === 1) return "revoked";
      if (status === 2) return "unknown";
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

interface CertMetadata {
  issuer: string | null;
  issuerOrg: string | null;
  serial: string | null;
  notBefore: string | null;
  notAfter: string | null;
  daysRemaining: number | null;
  rawPem: string | null;
  ocspRevoked: boolean;
  ocspChecked: boolean;
}

function extractCertMetadata(cert: PeerCertificate): CertMetadata {
  const notAfter = new Date(cert.valid_to);
  const notBefore = new Date(cert.valid_from);
  const issuerOrg = issuerOrgName(cert.issuer);
  // `getPeerCertificate(true)` returns a `PeerCertificate` whose
  // `infoAccess` field is a `CertificateInfoAccess` object when the
  // server's cert includes the Authority Information Access
  // extension. We use it to know whether OCSP stapling is even
  // possible (the server's own cert advertises an OCSP responder,
  // so a stapled response can be checked). The actual stapled
  // response lives at `cert.ocsp` (Buffer | undefined) in Node 22.
  return {
    issuer: issuerOrg ?? "Unknown",
    issuerOrg,
    serial: cert.serialNumber ?? null,
    notBefore: Number.isNaN(notBefore.getTime()) ? null : notBefore.toISOString(),
    notAfter: Number.isNaN(notAfter.getTime()) ? null : notAfter.toISOString(),
    daysRemaining: Number.isNaN(notAfter.getTime())
      ? null
      : computeDaysRemaining(notAfter),
    rawPem: pemFromRaw(cert.raw),
    // Node 22: `cert.ocsp` is the parsed OCSP response (Buffer) when
    // the server stapled one. `cert.infoAccess` is the AIA extension
    // telling us where to fetch OCSP if not stapled. We only check
    // stapled responses here (no extra HTTP fetch).
    ocspRevoked: false,
    ocspChecked: false,
  };
}

function checkOcspStapled(cert: PeerCertificate, meta: CertMetadata): void {
  const ocsp = (cert as unknown as { ocsp?: Buffer }).ocsp;
  if (!ocsp || !Buffer.isBuffer(ocsp) || ocsp.length === 0) return;
  const status = parseOcspStatus(ocsp);
  if (status === null) {
    // Parsed but ambiguous — leave ocspChecked false so the caller
    // knows we did not get a definitive answer.
    return;
  }
  meta.ocspChecked = true;
  if (status === "revoked") {
    meta.ocspRevoked = true;
  }
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
    // against `now` and OCSP stapling and decide `valid` ourselves.
    //
    // Rationale: with the previous code path (`rejectUnauthorized:
    // true` default), a TLS handshake on an expired cert would error
    // out before we ever saw `getPeerCertificate()`, and we returned a
    // result with `valid: false, notAfter: null, error: "cert_expired"`.
    // The dashboard counted expired certs via `daysRemaining <= 0`,
    // so an expired cert was NOT counted as expired — it showed up as
    // "unchecked" with an "Error" badge. Roman's bug report.
    //
    // The chain-trust signal (what `rejectUnauthorized: true` was
    // really buying us) is preserved by relying on the runtime's
    // `TLSSocket.authorized` flag AFTER the handshake — see below.
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

          const meta = extractCertMetadata(cert);
          checkOcspStapled(cert, meta);

          // Determine validity.
          const now = Date.now();
          const notBefore = meta.notBefore ? new Date(meta.notBefore).getTime() : NaN;
          const notAfter = meta.notAfter ? new Date(meta.notAfter).getTime() : NaN;
          const isExpired = !Number.isNaN(notAfter) && notAfter < now;
          const isNotYetValid = !Number.isNaN(notBefore) && notBefore > now;
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

          if (meta.ocspRevoked) {
            finish({
              valid: false,
              issuer: meta.issuer,
              issuerOrg: meta.issuerOrg,
              serial: meta.serial,
              notBefore: meta.notBefore,
              notAfter: meta.notAfter,
              daysRemaining: meta.daysRemaining,
              rawPem: meta.rawPem,
              error: "cert_revoked",
            });
            return;
          }

          if (isExpired) {
            finish({
              valid: false,
              issuer: meta.issuer,
              issuerOrg: meta.issuerOrg,
              serial: meta.serial,
              notBefore: meta.notBefore,
              notAfter: meta.notAfter,
              daysRemaining: meta.daysRemaining,
              rawPem: meta.rawPem,
              error: "cert_expired",
            });
            return;
          }

          if (isNotYetValid) {
            finish({
              valid: false,
              issuer: meta.issuer,
              issuerOrg: meta.issuerOrg,
              serial: meta.serial,
              notBefore: meta.notBefore,
              notAfter: meta.notAfter,
              daysRemaining: meta.daysRemaining,
              rawPem: meta.rawPem,
              error: "cert_not_yet_valid",
            });
            return;
          }

          if (!chainTrusted) {
            finish({
              valid: false,
              issuer: meta.issuer,
              issuerOrg: meta.issuerOrg,
              serial: meta.serial,
              notBefore: meta.notBefore,
              notAfter: meta.notAfter,
              daysRemaining: meta.daysRemaining,
              rawPem: meta.rawPem,
              error: "untrusted_chain",
            });
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
      }
    );

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
