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
  if (!raw) return "";
  const b64 = raw.toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
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

    const socket = connect(port, hostname, { servername: hostname }, () => {
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
          error: err instanceof Error ? err.message : String(err),
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
        error: err.message,
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
