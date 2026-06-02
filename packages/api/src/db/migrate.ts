import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb, closeDb } from "./index.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDatabasePath } from "./index.js";

export function runMigrations(): void {
  const db = getDb();
  const migrationsFolder = new URL("./migrations", import.meta.url).pathname;
  if (!existsSync(migrationsFolder)) {
    throw new Error(`Migrations folder not found: ${migrationsFolder}`);
  }
  migrate(db, { migrationsFolder });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = getDatabasePath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  runMigrations();
  console.log(`Migrations applied at ${dbPath}`);
  closeDb();
}
