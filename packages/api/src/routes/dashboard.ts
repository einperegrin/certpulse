import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { type DB, getDb } from "../db/index.js";
import { checks, domains } from "../db/schema.js";

export function createDashboardRouter(db: DB = getDb()): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const allDomains = db
      .select({
        id: domains.id,
        hostname: domains.hostname,
        port: domains.port,
        enabled: domains.enabled,
        lastCheck: {
          id: checks.id,
          valid: checks.valid,
          daysRemaining: checks.daysRemaining,
          notAfter: checks.notAfter,
          issuer: checks.issuer,
          issuerOrg: checks.issuerOrg,
          error: checks.error,
          checkedAt: checks.checkedAt,
        },
      })
      .from(domains)
      .leftJoin(checks, eq(checks.id, sql`(SELECT id FROM checks WHERE domain_id = domains.id ORDER BY checked_at DESC LIMIT 1)`))
      .all();

    const total = allDomains.length;
    const expiringSoon = allDomains.filter(
      (d) =>
        d.lastCheck?.daysRemaining !== null &&
        d.lastCheck?.daysRemaining !== undefined &&
        d.lastCheck.daysRemaining <= 30 &&
        d.lastCheck.daysRemaining > 0
    ).length;
    const expired = allDomains.filter(
      (d) =>
        d.lastCheck?.daysRemaining !== null &&
        d.lastCheck?.daysRemaining !== undefined &&
        d.lastCheck.daysRemaining <= 0
    ).length;
    const healthy = allDomains.filter(
      (d) =>
        d.lastCheck?.daysRemaining !== null &&
        d.lastCheck?.daysRemaining !== undefined &&
        d.lastCheck.daysRemaining > 30
    ).length;
    const unchecked = allDomains.filter((d) => !d.lastCheck).length;

    return c.json({
      total,
      expiringSoon,
      expired,
      healthy,
      unchecked,
      domains: allDomains,
    });
  });

  return app;
}

export const dashboardRouter = createDashboardRouter();
