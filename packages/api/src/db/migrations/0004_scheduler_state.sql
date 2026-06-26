-- SSLert v0.2 (H-3): Scheduler lock + state.
--
-- The pre-fix scheduler held a `running` boolean in module scope. A
-- crash would leave it true forever, and a parallel process (e.g. a
-- CLI-driven tick on top of the cron) would short-circuit silently.
--
-- We move the lock to the database so it survives crashes and works
-- across processes. The same key/value table will also hold the
-- retention timestamp (Task 2.4) and the last tick.
CREATE TABLE IF NOT EXISTS scheduler_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO scheduler_state (key, value) VALUES ('running', '0');
INSERT OR IGNORE INTO scheduler_state (key, value) VALUES ('last_tick', '');
INSERT OR IGNORE INTO scheduler_state (key, value) VALUES ('last_retention', '');
