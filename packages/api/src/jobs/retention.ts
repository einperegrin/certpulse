/**
 * Retention job (M-1).
 *
 * Bounded growth for the `checks` and `alerts` tables:
 *   - checks older than 90 days are deleted (we already have the full
 *     cert in the most-recent row for the dashboard)
 *   - alerts older than 365 days are deleted (audit history only)
 *
 * The job is invoked from the scheduler once per day and runs VACUUM
 * afterwards to reclaim the disk space.
 */
import { lt, sql } from "drizzle-orm";
import { type DB } from "../db/index.js";
import { checks, alerts } from "../db/schema.js";
import { logger } from "../services/logger.js";

export const CHECK_RETENTION_DAYS = 90;
export const ALERT_RETENTION_DAYS = 365;

const RETENTION_DAYS_ENV = "RETENTION_DAYS";
const ALERT_RETENTION_DAYS_ENV = "ALERT_RETENTION_DAYS";

/**
 * Read a retention window from the environment, with a module-level
 * fallback. We accept only positive integers in [1, 3650] days (~10
 * years) to bound operator error; otherwise we fall back to the
 * caller-supplied default. (Copilot review: retention.ts:30.)
 */
function readRetentionEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 3650) return fallback;
  return n;
}

/**
 * Format a JS Date offset from now in SQLite's `datetime('now')` form
 * (`YYYY-MM-DD HH:MM:SS` in UTC). The schema stores `checked_at` and
 * `created_at` in this exact format, so writing ISO-8601 with a `T`
 * separator breaks the lexicographic comparison in the WHERE clauses
 * below: a cutoff like "2025-01-01T00:00:00.000Z" sorts AFTER a
 * stored value like "2025-01-01 23:59:59" even though it's an earlier
 * instant, so up to ~24h of extra rows can be deleted around the
 * cutoff. (Copilot review: retention.ts:33.)
 */
function sqliteNowOffset(offsetMs: number): string {
  return new Date(Date.now() + offsetMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

export interface RetentionResult {
  deletedChecks: number;
  deletedAlerts: number;
}

export function runRetention(
  db: DB,
  options: { checkDays?: number; alertDays?: number } = {}
): RetentionResult {
  // Explicit argument > env var > module default. The env-var path is
  // what the PR body advertises ("RETENTION_DAYS / ALERT_RETENTION_DAYS
  // override") — without it, an operator can't tune retention without
  // recompiling.
  const checkDays = options.checkDays
    ?? readRetentionEnv(RETENTION_DAYS_ENV, CHECK_RETENTION_DAYS);
  const alertDays = options.alertDays
    ?? readRetentionEnv(ALERT_RETENTION_DAYS_ENV, ALERT_RETENTION_DAYS);

  const checkCutoff = sqliteNowOffset(-checkDays * 86_400_000);
  const alertCutoff = sqliteNowOffset(-alertDays * 86_400_000);

  const deletedChecks = db
    .delete(checks)
    .where(lt(checks.checkedAt, checkCutoff))
    .run().changes;
  const deletedAlerts = db
    .delete(alerts)
    .where(lt(alerts.createdAt, alertCutoff))
    .run().changes;

  // VACUUM to reclaim space. Has to run outside a transaction.
  try {
    db.run(sql`VACUUM`);
  } catch (err) {
    // VACUUM is best-effort — the next run will pick it up.
    logger.error({ err }, "VACUUM failed");
  }

  return { deletedChecks, deletedAlerts };
}
