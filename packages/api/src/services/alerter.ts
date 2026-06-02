import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Resend } from "resend";
import { getDb } from "../db/index.js";
import { alerts, checks, domains } from "../db/schema.js";

export type AlertLevel = "warning" | "urgent" | "critical" | "emergency";

export interface AlertLevelInfo {
  level: AlertLevel;
  subject: string;
  threshold: number;
}

const ALERT_LEVELS: AlertLevelInfo[] = [
  { level: "emergency", subject: "CERTIFICATE EXPIRED", threshold: 0 },
  { level: "critical", subject: "EXPIRES TOMORROW", threshold: 1 },
  { level: "urgent", subject: "Expires in 7 days", threshold: 7 },
  { level: "warning", subject: "Expires in 30 days", threshold: 30 },
];

export function determineAlertLevel(daysRemaining: number | null): AlertLevelInfo | null {
  if (daysRemaining === null || daysRemaining === undefined) return null;
  if (daysRemaining <= 0) return ALERT_LEVELS[0];
  if (daysRemaining <= 1) return ALERT_LEVELS[1];
  if (daysRemaining <= 7) return ALERT_LEVELS[2];
  if (daysRemaining <= 30) return ALERT_LEVELS[3];
  return null;
}

export interface AlertSendResult {
  level: AlertLevel;
  status: "sent" | "failed" | "skipped" | "deduped";
  messageId?: string;
  error?: string;
}

export interface AlertEmailPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface AlertEmailSender {
  send(payload: AlertEmailPayload): Promise<{ id?: string; error?: string }>;
}

class ResendEmailSender implements AlertEmailSender {
  private resend: Resend | null = null;
  constructor(apiKey: string | undefined) {
    if (apiKey) this.resend = new Resend(apiKey);
  }
  async send(payload: AlertEmailPayload): Promise<{ id?: string; error?: string }> {
    if (!this.resend) {
      console.log(`[alert:log] from=${payload.from} to=${payload.to} subject="${payload.subject}"`);
      console.log(payload.text);
      return { id: `log-${Date.now()}` };
    }
    try {
      const { data, error } = await this.resend.emails.send({
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
      });
      if (error) return { error: error.message ?? String(error) };
      return { id: data?.id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

let _sender: AlertEmailSender | null = null;
export function setAlertEmailSender(sender: AlertEmailSender): void {
  _sender = sender;
}
export function getDefaultSender(): AlertEmailSender {
  if (_sender) return _sender;
  _sender = new ResendEmailSender(process.env.RESEND_API_KEY);
  return _sender;
}

function wasRecentlyAlerted(
  domainId: number,
  level: AlertLevel,
  withinHours: number
): boolean {
  const db = getDb();
  const cutoff = new Date(Date.now() - withinHours * 3600 * 1000).toISOString();
  const row = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.domainId, domainId),
        eq(alerts.level, level),
        gte(alerts.createdAt, cutoff)
      )
    )
    .limit(1)
    .all();
  return row.length > 0;
}

export interface ProcessCheckAlertInput {
  checkId: number;
  domainId: number;
  daysRemaining: number | null;
}

export async function processCheckAlert(
  input: ProcessCheckAlertInput
): Promise<AlertSendResult | null> {
  const levelInfo = determineAlertLevel(input.daysRemaining);
  if (!levelInfo) return null;

  if (wasRecentlyAlerted(input.domainId, levelInfo.level, 24)) {
    return { level: levelInfo.level, status: "deduped" };
  }

  const db = getDb();
  const domain = db
    .select()
    .from(domains)
    .where(eq(domains.id, input.domainId))
    .limit(1)
    .all()[0];
  if (!domain) return null;

  const to = process.env.ALERT_EMAIL_TO;
  if (!to) {
    return { level: levelInfo.level, status: "skipped", error: "ALERT_EMAIL_TO not set" };
  }
  const from = process.env.ALERT_EMAIL_FROM ?? "certpulse@localhost";

  const days = input.daysRemaining ?? 0;
  const text = [
    `CertPulse SSL Alert`,
    ``,
    `Domain: ${domain.hostname}:${domain.port}`,
    `Days remaining: ${days}`,
    `Status: ${levelInfo.subject}`,
    ``,
    `Check #${input.checkId} recorded at ${new Date().toISOString()}`,
  ].join("\n");

  const sender = getDefaultSender();
  const result = await sender.send({ from, to, subject: `[CertPulse] ${domain.hostname}: ${levelInfo.subject}`, text });

  const status: "sent" | "failed" =
    result.error ? "failed" : "sent";
  const sentAt = status === "sent" ? new Date().toISOString() : null;

  db.insert(alerts)
    .values({
      domainId: input.domainId,
      checkId: input.checkId,
      level: levelInfo.level,
      type: "email",
      status,
      sentAt,
      error: result.error ?? null,
    })
    .run();

  return {
    level: levelInfo.level,
    status,
    messageId: result.id,
    error: result.error,
  };
}

export async function runAlertForCheck(
  checkId: number,
  domainId: number,
  daysRemaining: number | null
): Promise<AlertSendResult | null> {
  return processCheckAlert({ checkId, domainId, daysRemaining });
}

export function recentAlertsForDomain(domainId: number, limit = 20) {
  const db = getDb();
  return db
    .select()
    .from(alerts)
    .where(eq(alerts.domainId, domainId))
    .orderBy(desc(alerts.createdAt))
    .limit(limit)
    .all();
}

export function recentAlerts(limit = 20) {
  const db = getDb();
  return db
    .select({
      alert: alerts,
      domain: domains,
    })
    .from(alerts)
    .leftJoin(domains, sql`${alerts.domainId} = ${domains.id}`)
    .orderBy(desc(alerts.createdAt))
    .limit(limit)
    .all();
}
