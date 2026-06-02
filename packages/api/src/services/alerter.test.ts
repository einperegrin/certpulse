import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb, type DB } from "../db/index.js";
import { runSqlMigrations } from "../db/sqlmigrate.js";
import { checks, domains } from "../db/schema.js";
import Database from "better-sqlite3";
import {
  determineAlertLevel,
  processCheckAlert,
  setAlertEmailSender,
  type AlertEmailSender,
  type AlertEmailPayload,
} from "./alerter.js";

class MockSender implements AlertEmailSender {
  sent: AlertEmailPayload[] = [];
  async send(
    payload: AlertEmailPayload
  ): Promise<{ id?: string; error?: string }> {
    this.sent.push(payload);
    return { id: `mock-${this.sent.length}` };
  }
}

function makeDb(): { db: DB; sqlite: Database.Database } {
  const { db, sqlite } = createInMemoryDb();
  runSqlMigrations(sqlite);
  return { db, sqlite };
}

describe("determineAlertLevel", () => {
  it("returns warning for <=30 days", () => {
    expect(determineAlertLevel(30)?.level).toBe("warning");
    expect(determineAlertLevel(15)?.level).toBe("warning");
  });
  it("returns urgent for <=7 days", () => {
    expect(determineAlertLevel(7)?.level).toBe("urgent");
    expect(determineAlertLevel(3)?.level).toBe("urgent");
  });
  it("returns critical for <=1 day", () => {
    expect(determineAlertLevel(1)?.level).toBe("critical");
  });
  it("returns emergency for <=0 (expired)", () => {
    expect(determineAlertLevel(0)?.level).toBe("emergency");
    expect(determineAlertLevel(-1)?.level).toBe("emergency");
  });
  it("returns null for >30 days", () => {
    expect(determineAlertLevel(31)).toBeNull();
    expect(determineAlertLevel(60)).toBeNull();
  });
  it("returns null for null daysRemaining", () => {
    expect(determineAlertLevel(null)).toBeNull();
  });
});

describe("alert dedup", () => {
  let mock: MockSender;
  let db: DB;
  let sqlite: Database.Database;

  beforeEach(() => {
    const m = makeDb();
    db = m.db;
    sqlite = m.sqlite;
    mock = new MockSender();
    setAlertEmailSender(mock);
    process.env.ALERT_EMAIL_TO = "test@example.com";
    process.env.ALERT_EMAIL_FROM = "certpulse@example.com";
  });

  it("does not send duplicate alerts within 24h for the same level", async () => {
    const inserted = db
      .insert(domains)
      .values({ hostname: "example.com", port: 443 })
      .returning()
      .all();
    const domain = inserted[0]!;

    const c1 = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 5,
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + 5 * 86400_000).toISOString(),
      })
      .returning({ id: checks.id })
      .all()[0]!;

    const c2 = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 5,
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + 5 * 86400_000).toISOString(),
      })
      .returning({ id: checks.id })
      .all()[0]!;

    const a1 = await processCheckAlert({
      checkId: c1.id,
      domainId: domain.id,
      daysRemaining: 5,
      db,
    });
    const a2 = await processCheckAlert({
      checkId: c2.id,
      domainId: domain.id,
      daysRemaining: 5,
      db,
    });

    expect(a1?.status).toBe("sent");
    expect(a2?.status).toBe("deduped");
    expect(mock.sent.length).toBe(1);
  });

  it("sends separate alerts when level changes", async () => {
    const inserted = db
      .insert(domains)
      .values({ hostname: "example.com", port: 443 })
      .returning()
      .all();
    const domain = inserted[0]!;

    const c1 = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 20,
      })
      .returning({ id: checks.id })
      .all()[0]!;

    const c2 = db
      .insert(checks)
      .values({
        domainId: domain.id,
        valid: true,
        daysRemaining: 5,
      })
      .returning({ id: checks.id })
      .all()[0]!;

    const a1 = await processCheckAlert({
      checkId: c1.id,
      domainId: domain.id,
      daysRemaining: 20,
      db,
    });
    const a2 = await processCheckAlert({
      checkId: c2.id,
      domainId: domain.id,
      daysRemaining: 5,
      db,
    });
    expect(a1?.level).toBe("warning");
    expect(a2?.level).toBe("urgent");
    expect(mock.sent.length).toBe(2);
  });
});
