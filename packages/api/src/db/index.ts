import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema.js";

export type DB = BetterSQLite3Database<typeof schema>;

export function getDatabasePath(): string {
  const raw = process.env.DATABASE_PATH ?? "./data/sslert.db";
  return resolve(process.cwd(), raw);
}

let _db: DB | null = null;
let _sqlite: Database.Database | null = null;

export function getDb(): DB {
  if (_db) return _db;
  const path = getDatabasePath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  _sqlite = new Database(path);
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("foreign_keys = ON");
  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function getRawSqlite(): Database.Database {
  if (!_sqlite) {
    getDb();
  }
  return _sqlite!;
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

export function createInMemoryDb(): { db: DB; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
