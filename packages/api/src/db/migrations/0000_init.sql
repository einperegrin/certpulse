CREATE TABLE IF NOT EXISTS domains (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname    TEXT NOT NULL UNIQUE,
  port        INTEGER DEFAULT 443,
  enabled     INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id       INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  checked_at      TEXT DEFAULT (datetime('now')),
  valid           INTEGER NOT NULL,
  issuer          TEXT,
  issuer_org      TEXT,
  serial          TEXT,
  not_before      TEXT,
  not_after       TEXT,
  days_remaining  INTEGER,
  error           TEXT,
  raw_pem         TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  check_id    INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  level       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'email',
  status      TEXT NOT NULL DEFAULT 'pending',
  sent_at     TEXT,
  error       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_checks_domain_id ON checks(domain_id);
CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_domain_id ON alerts(domain_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_domain_level_time ON alerts(domain_id, level, created_at);
