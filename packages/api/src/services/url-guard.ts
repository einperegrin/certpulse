/**
 * Webhook-style URL validator. Closes H-1 (port/channel URL hardening).
 *
 * Alert channels (webhook, slack, ntfy) accept a URL we will POST to. The
 * URL must be public https (loopback http is allowed for dev/test) and
 * must not resolve to a private/loopback/link-local address. The same
 * guard powers the channel senders so the SSRF check runs at send time
 * (DNS-rebinding defence).
 */
import { isPrivateAddress } from "./ssrf-guard.js";

export interface UrlGuardResult {
  ok: boolean;
  error?: string;
}

const isLoopbackHostname = (h: string): boolean =>
  h === "localhost" || h === "127.0.0.1" || h === "::1";

/**
 * Validate a webhook-style URL.
 *
 * Rules:
 * - Must parse as a URL.
 * - Protocol must be https, EXCEPT http://localhost or http://127.0.0.1
 *   is allowed (dev/test escape hatch — the same way most teams exercise
 *   webhook receivers locally).
 * - Hostname must not resolve to a private/loopback/link-local address,
 *   unless ALLOW_PRIVATE_HOSTS=1 is set (air-gapped deployments).
 */
export async function validateWebhookUrl(rawUrl: string): Promise<UrlGuardResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "URL must use https://" };
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    return { ok: false, error: "http:// is only allowed for localhost (dev/test)" };
  }

  if (process.env.ALLOW_PRIVATE_HOSTS !== "1") {
    if (await isPrivateAddress(url.hostname)) {
      return {
        ok: false,
        error: "URL hostname is private/loopback/link-local",
      };
    }
  }

  return { ok: true };
}
