import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createInMemoryDb, type DB } from "../db/index.js";
import { runSqlMigrations } from "../db/sqlmigrate.js";
import { checks, domains } from "../db/schema.js";
import Database from "better-sqlite3";
import { startTlsTestServer, type TlsTestServer } from "./test-tls-server.js";
import {
  buildCronExpression,
  getCheckIntervalMinutes,
  isSchedulerRunning,
  startScheduler,
  stopScheduler,
  tickChecks,
} from "./scheduler.js";
describe("scheduler helpers", () => {
  it("returns the configured interval from env", () => {
    process.env.CHECK_INTERVAL = "15";
    expect(getCheckIntervalMinutes()).toBe(15);
    delete process.env.CHECK_INTERVAL;
    expect(getCheckIntervalMinutes()).toBe(60);
  });

  it("caps CHECK_INTERVAL at 24h (M-10) and falls back to 60 on garbage", () => {
    process.env.CHECK_INTERVAL = "9999";
    expect(getCheckIntervalMinutes()).toBe(60);
    process.env.CHECK_INTERVAL = "1440";
    expect(getCheckIntervalMinutes()).toBe(1440);
    process.env.CHECK_INTERVAL = "1441";
    expect(getCheckIntervalMinutes()).toBe(60);
    process.env.CHECK_INTERVAL = "not-a-number";
    expect(getCheckIntervalMinutes()).toBe(60);
    process.env.CHECK_INTERVAL = "0";
    expect(getCheckIntervalMinutes()).toBe(60);
    process.env.CHECK_INTERVAL = "-5";
    expect(getCheckIntervalMinutes()).toBe(60);
    delete process.env.CHECK_INTERVAL;
  });

  it("builds the expected cron expression", () => {
    expect(buildCronExpression(15)).toBe("*/15 * * * *");
    expect(buildCronExpression(60)).toBe("0 */1 * * *");
    expect(buildCronExpression(120)).toBe("0 */2 * * *");
    expect(buildCronExpression(720)).toBe("0 */12 * * *");
  });
});

describe("cron firing", () => {
  let db: DB;
  let sqlite: Database.Database;
  let server: TlsTestServer;
  let serverPort: number;

  beforeAll(async () => {
    server = await startTlsTestServer({ daysValid: 45 });
    serverPort = server.port;
    // The local TLS test server is on loopback. The SSRF guard in
    // checker-runner would otherwise refuse it; the env escape hatch is
    // exactly designed for this case (unit/integration testing).
    process.env.ALLOW_PRIVATE_HOSTS = "1";
  }, 30000);

  afterAll(async () => {
    await server.close();
    delete process.env.ALLOW_PRIVATE_HOSTS;
  });

  beforeEach(() => {
    const m = createInMemoryDb();
    db = m.db;
    sqlite = m.sqlite;
    runSqlMigrations(sqlite);
    stopScheduler();
  });

  it("tickChecks runs checks for all enabled domains and persists rows", async () => {
    db.insert(domains)
      .values({ hostname: "localhost", port: serverPort, enabled: true })
      .run();
    db.insert(domains)
      .values({ hostname: "127.0.0.1", port: serverPort + 1, enabled: false })
      .run();

    const result = await tickChecks(db, { rejectUnauthorized: false });
    expect(result.ran).toBe(1);

    const rows = db.select().from(checks).all();
    expect(rows.length).toBe(1);
    expect(rows[0]!.valid).toBe(true);
    expect(rows[0]!.daysRemaining).toBeGreaterThan(0);
  });

  it("startScheduler is idempotent and reports running state", () => {
    process.env.CHECK_INTERVAL = "60";
    expect(isSchedulerRunning()).toBe(false);
    const s1 = startScheduler(db);
    expect(isSchedulerRunning()).toBe(true);
    const s2 = startScheduler(db);
    expect(s2.task).toBe(s1.task);
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  it("stale-lock reclaim works when previous tick wrote updatedAt in SQLite datetime format (H-3)", async () => {
    // Seed scheduler_state with running=1 and updatedAt 31 minutes ago,
    // formatted as SQLite's `datetime('now', '-31 minutes')` would be.
    // If scheduler.ts wrote ISO-8601 with a `T` separator (the bug Copilot
    // flagged), the comparison `updated_at < datetime('now', '-30 minutes')`
    // would lexicographically fail because 'T' > ' ' in ASCII, leaving the
    // scheduler stuck. With sqliteNow() the reclaim should succeed.
    const { schedulerState } = await import("../db/schema.js");
    const stale = new Date(Date.now() - 31 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    db.insert(schedulerState)
      .values({ key: "running", value: "1", updatedAt: stale })
      .onConflictDoNothing()
      .run();

    db.insert(domains)
      .values({ hostname: "localhost", port: serverPort, enabled: true })
      .run();

    const result = await tickChecks(db, { rejectUnauthorized: false });
    expect(result.ran).toBe(1);
  });
});
