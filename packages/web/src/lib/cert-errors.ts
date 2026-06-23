/**
 * Map the stable error codes emitted by `services/checker.ts` to
 * human-readable strings suitable for the dashboard.
 *
 * Why a dedicated module
 * ----------------------
 * The checker writes short, kebab-case tokens into `checks.error`
 * (e.g. `cert_expired`, `cert_revoked`, `dns_not_found`). The UI
 * surfaces them in three places (DomainTable row, DomainDetail
 * page, and the dashboard summary cards). Each place used to either
 * show the raw token (ugly) or maintain its own copy of the map
 * (drift). This module is the single source of truth.
 *
 * `cert_revoked` is a v0.5 addition. The pre-v0.5 checker did not
 * check OCSP stapling, so a revoked-but-not-expired cert was
 * labelled `valid: true` and showed as "Healthy" — Roman's bug,
 * 2026-06-23.
 */

export interface CertErrorMessage {
  /** Short title, e.g. "Certificate expired". Used as a badge label. */
  title: string;
  /** Longer explanation. Used in tooltips and the detail page. */
  description: string;
}

const CERT_ERROR_MAP: Record<string, CertErrorMessage> = {
  cert_expired: {
    title: "Certificate expired",
    description:
      "The server's certificate has passed its `notAfter` date and is no longer valid. Renew it with your CA.",
  },
  cert_revoked: {
    title: "Certificate revoked",
    description:
      "The CA has revoked this certificate. Issue a new one and redeploy — browsers and CLI clients will refuse to trust it.",
  },
  cert_not_yet_valid: {
    title: "Certificate not yet valid",
    description:
      "The certificate's `notBefore` date is in the future. Check the system clock on both client and server.",
  },
  self_signed: {
    title: "Self-signed certificate",
    description:
      "The certificate chain does not terminate at a trusted root. Install the issuing CA's certificate in your trust store.",
  },
  untrusted_chain: {
    title: "Untrusted certificate chain",
    description:
      "OpenSSL could not verify the certificate against the local trust store. The chain is likely missing an intermediate CA certificate.",
  },
  hostname_mismatch: {
    title: "Hostname mismatch",
    description:
      "The certificate's Subject Alternative Name (SAN) does not include the hostname you are checking. Reissue with the correct hostname.",
  },
  dns_not_found: {
    title: "DNS lookup failed",
    description:
      "The hostname could not be resolved. Check the DNS records and whether the name exists.",
  },
  connection_refused: {
    title: "Connection refused",
    description:
      "The server actively refused the TCP connection. The service may be down or a firewall is blocking the port.",
  },
  tls_timeout: {
    title: "Connection timed out",
    description:
      "The TLS handshake did not complete within the timeout. The server may be unreachable or under heavy load.",
  },
  connection_reset: {
    title: "Connection reset",
    description:
      "The TCP connection was reset by the server or an intermediate hop mid-handshake.",
  },
  tls_error: {
    title: "TLS error",
    description:
      "An unspecified TLS error occurred. Check the API logs for the full libuv/OpenSSL message.",
  },
};

/**
 * Return a human-readable title for the given error code. Falls back
 * to a formatted version of the raw token so unknown codes never
 * render as the empty string.
 */
export function certErrorTitle(code: string | null | undefined): string {
  if (!code) return "";
  return (
    CERT_ERROR_MAP[code]?.title ??
    code
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

/**
 * Return a longer description for the given error code. Returns the
 * raw code when unknown — never the empty string — so an explanation
 * is always available.
 */
export function certErrorDescription(
  code: string | null | undefined
): string {
  if (!code) return "";
  return CERT_ERROR_MAP[code]?.description ?? code;
}

/**
 * Return the full record for a code, or `null` when the code is
 * not one of the well-known ones.
 */
export function certErrorInfo(code: string | null | undefined): CertErrorMessage | null {
  if (!code) return null;
  return CERT_ERROR_MAP[code] ?? null;
}

/**
 * Convenience alias kept for compatibility with pre-v0.5 call sites
 * that import `humanizeCertError`. New code should prefer
 * `certErrorTitle` / `certErrorDescription`.
 */
export function humanizeCertError(code: string | null | undefined): string {
  return certErrorTitle(code);
}

/**
 * Defence-in-depth normaliser for SQLite-style datetime strings.
 *
 * The API now returns proper ISO 8601 with `Z` for every datetime
 * column. But if a stale row (cached payload, older deploy) slips
 * through with `YYYY-MM-DD HH:MM:SS` (which JavaScript parses as
 * LOCAL time, not UTC), the UI would render the wrong "X ago"
 * distance in any browser east of UTC. We append `Z` if no
 * timezone indicator is present so `new Date(...)` always
 * interprets the value as UTC.
 *
 * Strings already in ISO format (with `Z` or `±HH:MM` offset) are
 * passed through unchanged.
 */
export function normalizeIsoForJs(value: string | null | undefined): string {
  if (!value) return value ?? "";
  // Already has timezone info? Pass through.
  if (/[zZ]$/.test(value) || /[+-]\d{2}:?\d{2}$/.test(value)) return value;
  // SQLite format: `YYYY-MM-DD HH:MM:SS` → `YYYY-MM-DDTHH:MM:SSZ`
  return value.replace(" ", "T") + "Z";
}