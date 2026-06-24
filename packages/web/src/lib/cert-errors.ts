// Map stable cert error codes (written by services/checker.ts into
// `checks.error`) to short, human-readable labels. Keep the keys in
// sync with the codes the checker emits.

const CERT_ERROR_TITLES: Record<string, string> = {
  cert_expired: "Certificate expired",
  cert_revoked: "Certificate revoked",
  cert_not_yet_valid: "Certificate not yet valid",
  self_signed: "Self-signed certificate",
  untrusted_chain: "Untrusted certificate chain",
  hostname_mismatch: "Hostname mismatch",
  dns_not_found: "DNS lookup failed",
  connection_refused: "Connection refused",
  tls_timeout: "Connection timed out",
  connection_reset: "Connection reset",
  tls_error: "TLS error",
};

const CERT_ERROR_DESCRIPTIONS: Record<string, string> = {
  cert_expired: "The server's certificate has passed its `notAfter` date and is no longer valid. Renew it with your CA.",
  cert_revoked: "The CA has revoked this certificate. Issue a new one and redeploy — browsers and CLI clients will refuse to trust it.",
  cert_not_yet_valid: "The certificate's `notBefore` date is in the future. Check the system clock on both client and server.",
  self_signed: "The certificate chain does not terminate at a trusted root. Install the issuing CA's certificate in your trust store.",
  untrusted_chain: "OpenSSL could not verify the certificate against the local trust store. The chain is likely missing an intermediate CA certificate.",
  hostname_mismatch: "The certificate's Subject Alternative Name (SAN) does not include the hostname you are checking. Reissue with the correct hostname.",
  dns_not_found: "The hostname could not be resolved. Check the DNS records and whether the name exists.",
  connection_refused: "The server actively refused the TCP connection. The service may be down or a firewall is blocking the port.",
  tls_timeout: "The TLS handshake did not complete within the timeout. The server may be unreachable or under heavy load.",
  connection_reset: "The TCP connection was reset by the server or an intermediate hop mid-handshake.",
  tls_error: "An unspecified TLS error occurred. Check the API logs for the full libuv/OpenSSL message.",
};

const fallback = (code: string) =>
  code
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");

export const certErrorTitle = (code: string | null | undefined): string =>
  (code && CERT_ERROR_TITLES[code]) || (code ? fallback(code) : "");

export const certErrorDescription = (code: string | null | undefined): string =>
  (code && CERT_ERROR_DESCRIPTIONS[code]) || code || "";

/** @deprecated use certErrorTitle */
export const humanizeCertError = certErrorTitle;

/** Normalise SQLite-style `YYYY-MM-DD HH:MM:SS` to ISO with Z so JS parses as UTC. */
export function normalizeIsoForJs(value: string | null | undefined): string {
  if (!value) return "";
  if (/[zZ]$/.test(value) || /[+-]\d{2}:?\d{2}$/.test(value)) return value;
  return value.replace(" ", "T") + "Z";
}
