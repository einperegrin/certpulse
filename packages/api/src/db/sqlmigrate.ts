import { readFileSync, readdirSync, existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { getRawSqlite } from "./index.js";

/**
 * Apply all SQL migrations in the migrations folder, in lexicographic order.
 * Each .sql file is executed inside a transaction; any failure rolls back.
 *
 * Idempotency: this is paired with `CREATE TABLE IF NOT EXISTS` and uses
 * `ALTER TABLE ... ADD COLUMN` semantics that tolerate existing columns via
 * try/catch at the statement level (see `execMigrationFile`).
 */
function listMigrationFiles(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".sql"))
    .sort();
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
  for (const file of listMigrationFiles(migrationsFolder)) {
    execMigrationFile(db, `${migrationsFolder}/${file}`);
  }
}
