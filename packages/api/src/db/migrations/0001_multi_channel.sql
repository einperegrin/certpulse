-- CertPulse v1: multi-channel alerts + domain expiry
-- Adds per-domain alert channel config table and domain-expiry columns to checks.
-- Also adds `source` and `channel` columns to alerts for distinguishing cert vs
-- domain expiry alerts and which channel dispatched them.

ALTER TABLE checks ADD COLUMN domain_expires_at TEXT;
ALTER TABLE checks ADD COLUMN domain_expires_days_remaining INTEGER;
ALTER TABLE checks ADD COLUMN domain_registrar TEXT;
ALTER TABLE checks ADD COLUMN domain_registrar_error TEXT;

ALTER TABLE alerts ADD COLUMN source TEXT NOT NULL DEFAULT 'cert';
ALTER TABLE alerts ADD COLUMN channel TEXT NOT NULL DEFAULT 'email';

CREATE TABLE IF NOT EXISTS alert_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_alert_channels_domain_id ON alert_channels(domain_id);
-- Updated dedup index to also key on (source, channel) so each channel/source
-- combination dedups independently.
DROP INDEX IF EXISTS idx_alerts_domain_level_time;
CREATE INDEX IF NOT EXISTS idx_alerts_domain_level_time
  ON alerts(domain_id, source, channel, level, created_at);
