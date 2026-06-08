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
});
