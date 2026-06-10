-- CertPulse v0.3: audit log table.
--
-- Records who did what to which resource, used by the new /api/audit-log
-- endpoint and the /audit web UI page. Retention is enforced by
-- `pruneAuditLog` (services/audit.ts) which is wired into the daily
-- retention tick.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT    NOT NULL DEFAULT (datetime('now')),
  actor_type    TEXT    NOT NULL,
  actor_id      TEXT,
  action        TEXT    NOT NULL,
  resource_type TEXT    NOT NULL,
  resource_id   TEXT,
  metadata      TEXT
);

-- Indexes for the common filter combinations the UI will hit.
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp     ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_type    ON audit_log(actor_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_action        ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource_type ON audit_log(resource_type);
