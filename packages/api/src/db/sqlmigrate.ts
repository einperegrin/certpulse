import { readFileSync, readdirSync, existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { getRawSqlite } from "./index.js";

/**
 * Apply all SQL migrations in the migrations folder, in lexicographic order.
 * Each .sql file is executed inside a transaction; any failure rolls back.
 *
 * Idempotency:
 *   1. Each applied filename is recorded in `__applied_migrations`. Files
 *      already present in that table are skipped on subsequent boots.
 *   2. Within a file, statements tolerate re-runs via `IF NOT EXISTS`
 *      and `INSERT OR IGNORE` clauses. `ALTER TABLE ... ADD COLUMN` is
 *      wrapped in a try/catch that swallows the "duplicate column name"
 *      error (see `execMigrationFile`). (v0.4.1 code-review CRITICAL —
 *      a future migration that does `INSERT …` would otherwise crash
 *      on every boot.)
 */
function listMigrationFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function ensureMigrationsTable(sqlite: Database.Database): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS __applied_migrations (
       filename  TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  );
}

function appliedMigrations(sqlite: Database.Database): Set<string> {
  const rows = sqlite
    .prepare("SELECT filename FROM __applied_migrations")
    .all() as Array<{ filename: string }>;
  return new Set(rows.map((r) => r.filename));
}

function markApplied(sqlite: Database.Database, filename: string): void {
  sqlite
    .prepare("INSERT OR IGNORE INTO __applied_migrations(filename) VALUES (?)")
    .run(filename);
}

function execMigrationFile(sqlite: Database.Database, path: string): void {
  const sql = readFileSync(path, "utf-8");
  // Split on semicolons that end a line, but keep things simple: the
  // migration files we author don't use triggers or semicolons inside
  // string literals, so a naive split is safe here.
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  sqlite.exec("BEGIN");
  try {
    for (const stmt of statements) {
      // ALTER TABLE ... ADD COLUMN is not idempotent in SQLite. Skip
      // "duplicate column" errors so re-running the migration is safe.
      try {
        sqlite.exec(stmt + ";");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/duplicate column name/i.test(msg)) continue;
        throw err;
      }
    }
    sqlite.exec("COMMIT");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  }
}

export function runSqlMigrations(sqlite?: Database.Database): void {
  const db = sqlite ?? getRawSqlite();
  const migrationsFolder = new URL("./migrations", import.meta.url).pathname;
  ensureMigrationsTable(db);
  const applied = appliedMigrations(db);
  for (const file of listMigrationFiles(migrationsFolder)) {
    if (applied.has(file)) continue;
    execMigrationFile(db, `${migrationsFolder}/${file}`);
    markApplied(db, file);
  }
}
