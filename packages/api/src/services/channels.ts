/**
 * Alert channel senders.
 *
 * Each channel implements `AlertChannelSender.send` and returns either
 * `{ id }` on success or `{ error }` on failure. Senders never throw —
 * all errors are caught and surfaced as `{ error }` so the alerter can
 * fall through to other channels.
 *
 * Configuration is channel-specific JSON. Validators run before send and
 * skip with `{ error: "..." }` if the config is missing required fields.
 *
 * URL-bearing senders (webhook, slack, ntfy) run every URL through
 * `validateWebhookUrl` before fetching — that rejects http to non-loopback
 * hostnames, blocks private/loopback/link-local targets, and is the
 * single chokepoint for H-1. The channels route also validates URLs at
 * write time so misconfig is caught at save, not at alert.
 */
import { validateWebhookUrl } from "./url-guard.js";

export type ChannelName = "email" | "webhook" | "telegram" | "slack" | "ntfy";

export interface AlertContent {
  subject: string;
  text: string;
  level: string;
  hostname: string;
  daysRemaining: number | null;
  source: "cert" | "domain";
}

export interface SendResult {
  id?: string;
  error?: string;
}

export interface AlertChannelSender {
  readonly channel: ChannelName;
  send(content: AlertContent, config: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<SendResult>;
}

// ---------- Email (Resend) ----------

class ResendEmailSender implements AlertChannelSender {
  readonly channel: ChannelName = "email";
  private apiKey: string | undefined;
  constructor(apiKey: string | undefined) {
    this.apiKey = apiKey;
  }
  async send(content: AlertContent, config: Record<string, unknown>): Promise<SendResult> {
    const to = typeof config.to === "string" ? config.to : (process.env.ALERT_EMAIL_TO ?? "");
    const from = typeof config.from === "string" ? config.from : (process.env.ALERT_EMAIL_FROM ?? "certpulse@localhost");
    if (!to) return { error: "No destination email configured" };
    if (!this.apiKey) {
      // Log to stdout — keeps the old fallback behaviour.
      console.log(`[alert:email:log] from=${from} to=${to} subject="${content.subject}"`);
      console.log(content.text);
      return { id: `log-${Date.now()}` };
    }
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(this.apiKey);
      const { data, error } = await resend.emails.send({
        from,
        to,
        subject: content.subject,
        text: content.text,
      });
      if (error) return { error: error.message ?? String(error) };
      return { id: data?.id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------- Generic Webhook ----------

class WebhookSender implements AlertChannelSender {
  readonly channel: ChannelName = "webhook";
  async send(content: AlertContent, config: Record<string, unknown>): Promise<SendResult> {
    const url = typeof config.url === "string" ? config.url : "";
    if (!url) return { error: "webhook URL not configured" };
    // SSRF + scheme guard (H-1). Re-validated at send time because a
    // hostname that was public at config-save may have flipped private.
    const v = await validateWebhookUrl(url);
    if (!v.ok) return { error: v.error ?? "Invalid webhook URL" };
    const payload = {
      source: content.source,
      level: content.level,
      hostname: content.hostname,
      daysRemaining: content.daysRemaining,
      subject: content.subject,
      text: content.text,
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { error: `Webhook HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
      }
      return { id: `webhook-${res.status}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------- Telegram ----------

class TelegramSender implements AlertChannelSender {
  readonly channel: ChannelName = "telegram";
  async send(content: AlertContent, config: Record<string, unknown>): Promise<SendResult> {
    const botToken = typeof config.botToken === "string" ? config.botToken : "";
    const chatId = typeof config.chatId === "string" || typeof config.chatId === "number"
      ? String(config.chatId)
      : "";
    if (!botToken) return { error: "Telegram botToken not configured" };
    if (!chatId) return { error: "Telegram chatId not configured" };
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `*${content.subject}*\n\n${content.text}`,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { error: `Telegram HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      const data = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
      return { id: data?.result?.message_id ? `tg-${data.result.message_id}` : "tg-ok" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------- Slack ----------

class SlackSender implements AlertChannelSender {
  readonly channel: ChannelName = "slack";
  async send(content: AlertContent, config: Record<string, unknown>): Promise<SendResult> {
    const url = typeof config.url === "string" ? config.url : "";
    if (!url) return { error: "Slack webhook URL not configured" };
    // SSRF + scheme guard (H-1) — Slack URLs should always be https to
    // hooks.slack.com, but we let validateWebhookUrl enforce it.
    const v = await validateWebhookUrl(url);
    if (!v.ok) return { error: v.error ?? "Invalid Slack URL" };
    const emoji = content.source === "domain" ? ":globe_with_meridians:" : ":lock:";
    const payload = {
      text: `${emoji} *${content.subject}*\n\`${content.hostname}\`\n${content.text}`,
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { error: `Slack HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { id: `slack-${res.status}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------- ntfy ----------

class NtfySender implements AlertChannelSender {
  readonly channel: ChannelName = "ntfy";
  async send(content: AlertContent, config: Record<string, unknown>): Promise<SendResult> {
    // Allow `topic` shorthand (https://ntfy.sh/<topic>) or full `url`.
    let url = typeof config.url === "string" ? config.url : "";
    if (!url && typeof config.topic === "string" && config.topic) {
      const server = typeof config.server === "string" && config.server ? config.server.replace(/\/$/, "") : "https://ntfy.sh";
      url = `${server}/${config.topic}`;
    }
    if (!url) return { error: "ntfy topic or URL not configured" };
    // SSRF + scheme guard (H-1). ntfy.sh is the default, but operators
    // can self-host — the guard ensures we never POST to a private target.
    const v = await validateWebhookUrl(url);
    if (!v.ok) return { error: v.error ?? "Invalid ntfy URL" };
    const priority = content.level === "emergency" || content.level === "critical" ? "5" : "3";
    const tags = content.source === "domain" ? "globe_with_meridians,rotating_light" : "lock,rotating_light";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Title": content.subject,
          "Priority": priority,
          "Tags": tags,
          "Content-Type": "text/plain",
        },
        body: content.text,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { error: `ntfy HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
      return { id: `ntfy-${res.status}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---------- Registry ----------

const senders: Record<ChannelName, AlertChannelSender> = {
  email: new ResendEmailSender(process.env.RESEND_API_KEY),
  webhook: new WebhookSender(),
  telegram: new TelegramSender(),
  slack: new SlackSender(),
  ntfy: new NtfySender(),
};

/**
 * Test-only: replace a channel sender with a stub. Production code should
 * never call this — it exists so alerter tests can verify dispatch logic
 * without hitting the network.
 */
export function setChannelSender(
  name: ChannelName,
  sender: AlertChannelSender
): void {
  senders[name] = sender;
}

export function resetChannelSender(name: ChannelName): void {
  switch (name) {
    case "email":
      senders[name] = new ResendEmailSender(process.env.RESEND_API_KEY);
      break;
    case "webhook":
      senders[name] = new WebhookSender();
      break;
    case "telegram":
      senders[name] = new TelegramSender();
      break;
    case "slack":
      senders[name] = new SlackSender();
      break;
    case "ntfy":
      senders[name] = new NtfySender();
      break;
  }
}

export function getChannelSender(name: ChannelName): AlertChannelSender {
  return senders[name];
}

export function listChannelNames(): ChannelName[] {
  return Object.keys(senders) as ChannelName[];
}

export function setEmailApiKey(apiKey: string | undefined): void {
  senders.email = new ResendEmailSender(apiKey);
}
