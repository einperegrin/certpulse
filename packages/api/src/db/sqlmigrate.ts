import { readFileSync, existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { getRawSqlite } from "./index.js";

export function runSqlMigrations(sqlite?: Database.Database): void {
  const db = sqlite ?? getRawSqlite();
  const migrationsFolder = new URL("./migrations", import.meta.url).pathname;
  const initFile = `${migrationsFolder}/0000_init.sql`;
  if (existsSync(initFile)) {
    const sql = readFileSync(initFile, "utf-8");
    db.exec(sql);
  }
}
