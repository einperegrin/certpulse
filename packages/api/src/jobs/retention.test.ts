import { describe, it, expect } from "vitest";
import { createInMemoryDb, type DB } from "../db/index.js";
import { runSqlMigrations } from "../db/sqlmigrate.js";
import { checks, alerts, domains } from "../db/schema.js";
import { runRetention } from "./retention.js";

function makeDb(): { db: DB } {
  const { db, sqlite } = createInMemoryDb();
  runSqlMigrations(sqlite);
  return { db };
}

describe("retention job (M-1)", () => {
  it("deletes checks older than the cutoff", () => {
    const { db } = makeDb();
    const inserted = db
      .insert(domains)
      .values({ hostname: "retention.example", port: 443 })
      .returning()
      .all();
    const domain = inserted[0]!;
    // Three checks: very old, just-older-than-window, fresh.
    const now = Date.now();
    const old = new Date(now - 1000 * 86400_000).toISOString();
    const recent = new Date(now - 5 * 86400_000).toISOString();
    const fresh = new Date(now - 1 * 86400_000).toISOString();
    db.insert(checks).values({ domainId: domain.id, valid: true, checkedAt: old }).run();
    db.insert(checks).values({ domainId: domain.id, valid: true, checkedAt: recent }).run();
    db.insert(checks).values({ domainId: domain.id, valid: true, checkedAt: fresh }).run();

    const r = runRetention(db, { checkDays: 30 });
    expect(r.deletedChecks).toBe(1); // only the very-old row
    const remaining = db.select().from(checks).all();
    expect(remaining).toHaveLength(2);
  });

  it("deletes alerts older than the cutoff", () => {
    const { db } = makeDb();
    const inserted = db
      .insert(domains)
      .values({ hostname: "retention.example", port: 443 })
      .returning()
      .all();
    const domain = inserted[0]!;
    const c = db
      .insert(checks)
      .values({ domainId: domain.id, valid: true })
      .returning({ id: checks.id })
      .all()[0]!;
    const now = Date.now();
    const ancient = new Date(now - 400 * 86400_000).toISOString();
    const fresh = new Date(now - 10 * 86400_000).toISOString();
    db.insert(alerts).values({ domainId: domain.id, checkId: c.id, level: "warning", channel: "email", source: "cert", status: "sent", createdAt: ancient }).run();
    db.insert(alerts).values({ domainId: domain.id, checkId: c.id, level: "warning", channel: "email", source: "cert", status: "sent", createdAt: fresh }).run();

    const r = runRetention(db, { alertDays: 365 });
    expect(r.deletedAlerts).toBe(1);
    const remaining = db.select().from(alerts).all();
    expect(remaining).toHaveLength(1);
  });

  it("uses 90d/365d defaults when no overrides are passed", () => {
    const { db } = makeDb();
    const inserted = db
      .insert(domains)
      .values({ hostname: "r.example", port: 443 })
      .returning()
      .all();
    const domain = inserted[0]!;
    const c = db
      .insert(checks)
      .values({ domainId: domain.id, valid: true })
      .returning({ id: checks.id })
      .all()[0]!;
    // 100-day-old check: older than the 90d default, should be deleted.
    const old = new Date(Date.now() - 100 * 86400_000).toISOString();
    db.insert(checks).values({ domainId: domain.id, valid: true, checkedAt: old }).run();
    db.insert(alerts).values({
      domainId: domain.id, checkId: c.id, level: "warning", channel: "email", source: "cert", status: "sent",
      createdAt: new Date(Date.now() - 100 * 86400_000).toISOString(),
    }).run();

    const r = runRetention(db);
    expect(r.deletedChecks).toBe(1);
    expect(r.deletedAlerts).toBe(0); // 100d < 365d default
  });
});
