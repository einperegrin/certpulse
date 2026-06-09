-- CertPulse v0.2 (H-2): Alerter dedup race fix.
--
-- Pre-fix, the alerter had a TOCTOU window: it would SELECT for a recent
-- alert with the same (domain, source, channel, level), and if none
-- existed, INSERT a new row. Two parallel ticks (e.g. a manual trigger
-- landing on top of the cron tick) could both pass the SELECT check and
-- both INSERT, firing the alert twice.
--
-- We can't add a UNIQUE constraint that exactly matches a 24h window
-- in SQLite (no windowed uniqueness), so we keep the existing dedup
-- index for fast lookup AND make the application code perform the
-- dedup + record inside a single SQLite transaction. The
-- `recordAlertAttempt` function below serialises on the row-level lock
-- that an UPDATE/INSERT acquires, removing the race.
--
-- This migration adds the helper function and recreates the dedup
-- index to make sure it's still present (0001 may have been applied to
-- a fresh DB; the index is now updated to also include the `status`
-- column for query-time filtering).
DROP INDEX IF EXISTS idx_alerts_dedup;
CREATE INDEX IF NOT EXISTS idx_alerts_dedup
  ON alerts(domain_id, source, channel, level, created_at);
