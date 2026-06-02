import { readFileSync, existsSync } from "node:fs";
import { getRawSqlite } from "./index.js";

export function runSqlMigrations(): void {
  const sqlite = getRawSqlite();
  const migrationsFolder = new URL("./migrations", import.meta.url).pathname;
  const initFile = `${migrationsFolder}/0000_init.sql`;
  if (existsSync(initFile)) {
    const sql = readFileSync(initFile, "utf-8");
    sqlite.exec(sql);
  }
}
