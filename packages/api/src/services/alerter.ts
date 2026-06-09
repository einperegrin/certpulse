import { and, desc, eq, gte, sql } from "drizzle-orm";
import { type DB, getDb } from "../db/index.js";
import { alertChannels, alerts, checks, domains, type AlertChannel } from "../db/schema.js";
import {
  type AlertContent,
  type ChannelName,
  getChannelSender,
} from "./channels.js";
import { logger } from "./logger.js";

export type AlertLevel = "warning" | "urgent" | "critical" | "emergency";
export type AlertSource = "cert" | "domain";

export interface AlertLevelInfo {
  level: AlertLevel;
  subject: string;
  threshold: number;
}

const ALERT_LEVELS: AlertLevelInfo[] = [
  { level: "emergency", subject: "EXPIRED", threshold: 0 },
  { level: "critical", subject: "EXPIRES TOMORROW", threshold: 1 },
  { level: "urgent", subject: "Expires in 7 days", threshold: 7 },
  { level: "warning", subject: "Expires in 30 days", threshold: 30 },
];

const SUBJECT_PREFIX_CERT = "[CertPulse]";
const SUBJECT_PREFIX_DOMAIN = "[CertPulse Domain]";

/**
 * Format a JS Date in SQLite's `datetime('now')` form
 * (`YYYY-MM-DD HH:MM:SS` in UTC). The schema's DEFAULT clauses use
 * this exact format for timestamp columns, so writing ISO-8601 with a
 * `T` separator breaks lexicographic text comparison in WHERE clauses
 * (an ISO string with `T` is lexicographically greater than a SQLite
 * `YYYY-MM-DD HH:MM:SS` even when the underlying instant is older).
 * (Copilot review: alerter.ts:84.)
 */
function sqliteNowOffset(offsetMs: number): string {
  return new Date(Date.now() + offsetMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

export function determineAlertLevel(daysRemaining: number | null | undefined): AlertLevelInfo | null {
  if (daysRemaining === null || daysRemaining === undefined) return null;
  if (daysRemaining <= 0) return ALERT_LEVELS[0];
  if (daysRemaining <= 1) return ALERT_LEVELS[1];
  if (daysRemaining <= 7) return ALERT_LEVELS[2];
  if (daysRemaining <= 30) return ALERT_LEVELS[3];
  return null;
}

export interface ChannelDispatchResult {
  channel: ChannelName;
  source: AlertSource;
  level: AlertLevel;
  status: "sent" | "failed" | "skipped" | "deduped";
  messageId?: string;
  error?: string;
}

export interface ProcessCheckAlertInput {
  checkId: number;
  domainId: number;
  certDaysRemaining: number | null;
  domainDaysRemaining: number | null;
  db?: DB;
}

export interface ProcessCheckAlertOutput {
  cert: ChannelDispatchResult[] | null;
  domain: ChannelDispatchResult[] | null;
}

/**
 * Returns true when no recent alert exists for this (domain, source,
 * channel, level) tuple within the dedup window. The check and the
 * subsequent `INSERT` in `recordAlertRow` are now performed inside a
 * single SQLite transaction so two parallel ticks cannot both see
 * "no recent alert" and both fire. (H-2 fix.)
 *
 * We can't get a strict 24h UNIQUE constraint in SQLite, so atomicity
 * comes from the transaction wrapping the SELECT and INSERT — SQLite
 * serialises writers, so a second concurrent caller will see the row
 * committed by the first.
 */
function recordAlertAttempt(
  db: DB,
  input: {
    domainId: number;
    source: AlertSource;
    channel: ChannelName;
    level: AlertLevel;
    dedupWindowHours: number;
  }
): boolean {
  // SQLite stores `created_at` as `datetime('now')` — i.e. UTC text in
  // `YYYY-MM-DD HH:MM:SS` form. A JS `toISOString()` is lexicographically
  // greater (`T` > ` `, plus a `.000Z` suffix) so a cutoff that mixes
  // the two formats can be > newer alerts and miss dedup hits. Format
  // the cutoff the same way the column stores it. (Copilot review:
  // alerter.ts:84.)
  const cutoff = sqliteNowOffset(-input.dedupWindowHours * 3600 * 1000);
  const recent = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.domainId, input.domainId),
        eq(alerts.source, input.source),
        eq(alerts.channel, input.channel),
        eq(alerts.level, input.level),
        gte(alerts.createdAt, cutoff)
      )
    )
    .limit(1)
    .all();
  return recent.length === 0;
}

function channelsForDomain(domainId: number, db: DB): AlertChannel[] {
  return db
    .select()
    .from(alertChannels)
    .where(and(eq(alertChannels.domainId, domainId), eq(alertChannels.enabled, true)))
    .all();
}

/**
 * Returns true if the email channel should fire for this domain, even when no
 * explicit alert_channels row exists. This preserves the v0 behaviour: a
 * domain with `ALERT_EMAIL_TO` set globally still gets email alerts.
 */
function defaultEmailChannel(domainId: number, db: DB): AlertChannel | null {
  const existing = db
    .select()
    .from(alertChannels)
    .where(and(eq(alertChannels.domainId, domainId), eq(alertChannels.channel, "email")))
    .limit(1)
    .all()[0];
  if (existing) return existing.enabled ? existing : null;
  // No explicit row — use global env as a synthetic, always-enabled channel.
  if (process.env.ALERT_EMAIL_TO) {
    return {
      id: 0,
      domainId,
      channel: "email",
      enabled: true,
      config: "{}",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
}

function buildAlertText(
  source: AlertSource,
  domain: { hostname: string; port: number },
  level: AlertLevelInfo,
  daysRemaining: number,
  checkId: number
): string {
  const lines: string[] = [
    `CertPulse ${source === "domain" ? "Domain" : "SSL"} Alert`,
    ``,
    `Domain: ${domain.hostname}:${domain.port}`,
    source === "domain"
      ? `Days until registration expires: ${daysRemaining}`
      : `Days remaining: ${daysRemaining}`,
    `Status: ${level.subject}`,
    ``,
    `Check #${checkId} recorded at ${new Date().toISOString()}`,
  ];
  return lines.join("\n");
}

function buildAlertSubject(
  source: AlertSource,
  domain: { hostname: string },
  level: AlertLevelInfo
): string {
  const prefix = source === "domain" ? SUBJECT_PREFIX_DOMAIN : SUBJECT_PREFIX_CERT;
  return `${prefix} ${domain.hostname}: ${level.subject}`;
}

async function dispatchOne(
  source: AlertSource,
  domain: { hostname: string; port: number },
  level: AlertLevelInfo,
  daysRemaining: number,
  checkId: number,
  domainId: number,
  db: DB
): Promise<ChannelDispatchResult[]> {
  const results: ChannelDispatchResult[] = [];
  // Build the dispatch list: per-domain channels + default email if none set.
  const explicit = channelsForDomain(domainId, db).filter((c) => c.channel !== "email");
  const defaultEmail = defaultEmailChannel(domainId, db);
  const dispatchList: AlertChannel[] = [...explicit];
  if (defaultEmail) dispatchList.push(defaultEmail);

  const content: AlertContent = {
    subject: buildAlertSubject(source, domain, level),
    text: buildAlertText(source, domain, level, daysRemaining, checkId),
    level: level.level,
    hostname: `${domain.hostname}:${domain.port}`,
    daysRemaining,
    source,
  };

  for (const ch of dispatchList) {
    const channelName = ch.channel as ChannelName;
    // Atomic dedup (H-2): wrap the "is there a recent alert?" check and
    // the INSERT of the deduped record in a single transaction. If a
    // concurrent tick has already recorded an alert for this tuple, the
    // SELECT inside the transaction will see it and we mark the channel
    // as deduped without firing.
    const dedupKey = {
      domainId,
      source,
      channel: channelName,
      level: level.level,
    };
    // Atomic dedup (H-2): the SELECT and the claim INSERT both happen
    // inside one transaction. A concurrent tick that runs while this
    // transaction is open blocks on the SQLite writer-lock; when it
    // gets the lock, the claim row is committed and
    // `recordAlertAttempt` returns false, so the second tick sees the
    // dedup. The claim row is created with status="pending" and is
    // resolved in place once the sender returns (status="sent"/
    // "failed"/"skipped") via `recordAlertRow` with `pendingId` set —
    // we UPDATE the same row instead of INSERTing a duplicate, so the
    // alerts table has exactly one row per dispatch attempt and the
    // audit log stays clean. (Copilot review: alerter.ts:359.)
    const claim = db.transaction((tx) => {
      const fresh = recordAlertAttempt(tx as DB, {
        ...dedupKey,
        dedupWindowHours: 24,
      });
      if (!fresh) {
        // Insert the deduped row inside the same transaction so the
        // audit log still records the suppressed attempt. No pending
        // row was created, so no `pendingId` to update.
        try {
          tx.insert(alerts)
            .values({
              domainId,
              checkId,
              source,
              channel: channelName,
              level: level.level,
              status: "deduped",
            })
            .run();
        } catch (err) {
          // Same swallow as the standalone recordAlertRow — we never
          // want dedup bookkeeping to crash an alert dispatch.
          logger.error({ err }, "failed to record deduped row");
        }
        return { isNew: false, pendingId: undefined as number | undefined };
      }
      // Claim the dedup window by inserting a "pending" row inside the
      // transaction. A concurrent tick that runs `recordAlertAttempt`
      // after this commit will see this row and dedupe. We capture
      // the row id via RETURNING so the dispatch loop can resolve it
      // to "sent"/"failed"/"skipped" without a second INSERT.
      let pendingId: number | undefined;
      try {
        const inserted = tx.insert(alerts)
          .values({
            domainId,
            checkId,
            source,
            channel: channelName,
            level: level.level,
            status: "pending",
          })
          .returning({ id: alerts.id })
          .all();
        pendingId = inserted[0]?.id;
      } catch (err) {
        logger.error({ err }, "failed to record pending claim row");
      }
      return { isNew: true, pendingId };
    });
    if (!claim.isNew) {
      results.push({ channel: channelName, source, level: level.level, status: "deduped" });
      continue;
    }
    let cfg: Record<string, unknown> = {};
    try {
      cfg = ch.config ? (JSON.parse(ch.config) as Record<string, unknown>) : {};
    } catch {
      cfg = {};
    }
    const sender = getChannelSender(channelName);
    // Pre-flight: channels with missing required config are "skipped", not "failed".
    // A failed delivery means the sender was invoked but returned an error.
    // A skipped channel means we never tried to send because config was invalid.
    //
    // Special case: email uses a synthetic default channel with empty config
    // and pulls the recipient from `ALERT_EMAIL_TO` env. The sender handles
    // that fallback, so we don't pre-flight email.
    if (channelName !== "email") {
      const requiredKeys: Record<string, string> = {
        webhook: "url",
        telegram: "chatId",
        slack: "url",
        ntfy: "topic",
      };
      const requiredKey = requiredKeys[channelName];
      if (requiredKey && (cfg[requiredKey] === undefined || cfg[requiredKey] === null || cfg[requiredKey] === "")) {
        results.push({
          channel: channelName, source, level: level.level,
          status: "skipped",
          error: `Missing required config: ${requiredKey}`,
        });
        recordAlertRow(db, {
          domainId, checkId, source,
          channel: channelName, level: level.level,
          status: "skipped",
          error: `Missing required config: ${requiredKey}`,
          pendingId: claim.pendingId,
        });
        continue;
      }
    }
    const sendRes = await sender.send(content, cfg, process.env);
    if (sendRes.error) {
      results.push({ channel: channelName, source, level: level.level, status: "failed", error: sendRes.error });
      recordAlertRow(db, {
        domainId,
        checkId,
        source,
        channel: channelName,
        level: level.level,
        status: "failed",
        error: sendRes.error,
        pendingId: claim.pendingId,
      });
    } else {
      results.push({ channel: channelName, source, level: level.level, status: "sent", messageId: sendRes.id });
      recordAlertRow(db, {
        domainId,
        checkId,
        source,
        channel: channelName,
        level: level.level,
        status: "sent",
        messageId: sendRes.id,
        pendingId: claim.pendingId,
      });
    }
  }
  return results;
}

interface RecordAlertRowInput {
  domainId: number;
  checkId: number;
  source: AlertSource;
  channel: ChannelName;
  level: string;
  status: "sent" | "failed" | "skipped" | "deduped";
  messageId?: string;
  error?: string;
  /**
   * If set, UPDATE the existing "pending" claim row to the final status
   * instead of INSERTing a new row. The atomic-dedup path (H-2) inserts
   * a pending row inside its claim transaction and hands the row's id
   * back here; the dispatch loop then UPDATEs that same row with the
   * final status. Without this, every successful alert would leave
   * behind a permanent "pending" row in addition to the "sent" row,
   * inflating the alerts table and misleading the audit log.
   * (Copilot review: alerter.ts:359.)
   */
  pendingId?: number;
}

function recordAlertRow(db: DB, input: RecordAlertRowInput): void {
  try {
    if (input.pendingId !== undefined) {
      // Resolve the pending claim in place. sentAt is set only on
      // successful send; the schema leaves it null for failed/skipped.
      // Note: the `alerts` schema doesn't have a `messageId` column
      // (the channel-specific id lives in `error`/`sentAt` indirectly,
      // and the canonical record is the row in this table), so the
      // messageId field is dropped here — it was already informational
      // in the INSERT path. (Copilot review: alerter.ts:359.)
      db.update(alerts)
        .set({
          status: input.status,
          sentAt:
            input.status === "sent"
              ? new Date().toISOString()
              : null,
          error: input.error ?? null,
        })
        .where(eq(alerts.id, input.pendingId))
        .run();
      return;
    }
    db.insert(alerts)
      .values({
        domainId: input.domainId,
        checkId: input.checkId,
        source: input.source,
        channel: input.channel,
        level: input.level,
        status: input.status,
        sentAt: input.status === "sent" ? new Date().toISOString() : null,
        error: input.error ?? null,
      })
      .run();
  } catch (err) {
    logger.error({ err }, "failed to record alert row");
  }
}

/**
 * Process a single check and fire alerts across all enabled channels.
 * Two alert groups are evaluated independently:
 *   - cert expiry  (source = "cert")
 *   - domain expiry (source = "domain")
 */
export async function processCheckAlert(
  input: ProcessCheckAlertInput
): Promise<ProcessCheckAlertOutput> {
  const db = input.db ?? getDb();
  const domain = db
    .select()
    .from(domains)
    .where(eq(domains.id, input.domainId))
    .limit(1)
    .all()[0];
  if (!domain) return { cert: null, domain: null };

  const out: ProcessCheckAlertOutput = { cert: null, domain: null };

  const certLevel = determineAlertLevel(input.certDaysRemaining);
  if (certLevel && input.certDaysRemaining !== null && input.certDaysRemaining !== undefined) {
    out.cert = await dispatchOne(
      "cert",
      { hostname: domain.hostname, port: domain.port },
      certLevel,
      input.certDaysRemaining,
      input.checkId,
      input.domainId,
      db
    );
  }

  const domainLevel = determineAlertLevel(input.domainDaysRemaining);
  if (domainLevel && input.domainDaysRemaining !== null && input.domainDaysRemaining !== undefined) {
    out.domain = await dispatchOne(
      "domain",
      { hostname: domain.hostname, port: domain.port },
      domainLevel,
      input.domainDaysRemaining,
      input.checkId,
      input.domainId,
      db
    );
  }

  return out;
}

/** Back-compat: process a check as if it were a cert-only alert. */
export async function runAlertForCheck(
  checkId: number,
  domainId: number,
  daysRemaining: number | null
): Promise<ChannelDispatchResult[] | null> {
  const out = await processCheckAlert({ checkId, domainId, certDaysRemaining: daysRemaining, domainDaysRemaining: null });
  return out.cert;
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
