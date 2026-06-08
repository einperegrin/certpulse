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

export interface RetentionResult {
  deletedChecks: number;
  deletedAlerts: number;
}

export function runRetention(
  db: DB,
  options: { checkDays?: number; alertDays?: number } = {}
): RetentionResult {
  const checkDays = options.checkDays ?? CHECK_RETENTION_DAYS;
  const alertDays = options.alertDays ?? ALERT_RETENTION_DAYS;

  const checkCutoff = new Date(Date.now() - checkDays * 86400_000).toISOString();
  const alertCutoff = new Date(Date.now() - alertDays * 86400_000).toISOString();

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
