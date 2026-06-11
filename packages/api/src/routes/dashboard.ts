import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "../db/index.js";
import { checks, domains } from "../db/schema.js";
import { openApiRegistry } from "../openapi/registry.js";
import { dashboardSchema } from "../openapi/schemas.js";

export function createDashboardRouter(db: DB = getDb()): Hono {
  const app = new Hono();

  // Document /api/dashboard. The response shape is fully described by
  // the shared `dashboardSchema`; the `domains` array element shape is
  // left as `z.unknown()` because the live payload is a Drizzle row
  // left-joined with the latest check (see the `lastCheck` subobject
  // in `DomainWithCheck`). Tightening that further is left to a
  // follow-up; the spec is still useful as-is.
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/dashboard",
    summary: "Get the dashboard summary",
    tags: ["dashboard"],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Summary counts + the per-domain list",
        content: {
          "application/json": { schema: dashboardSchema },
        },
      },
    },
  });

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
          domainExpiresAt: checks.domainExpiresAt,
          domainExpiresDaysRemaining: checks.domainExpiresDaysRemaining,
          domainRegistrar: checks.domainRegistrar,
          domainRegistrarError: checks.domainRegistrarError,
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

    // Domain-registration expiry stats: independent of cert expiry.
    const domainExpiringSoon = allDomains.filter(
      (d) =>
        d.lastCheck?.domainExpiresDaysRemaining !== null &&
        d.lastCheck?.domainExpiresDaysRemaining !== undefined &&
        d.lastCheck.domainExpiresDaysRemaining <= 30 &&
        d.lastCheck.domainExpiresDaysRemaining > 0
    ).length;
    const domainExpired = allDomains.filter(
      (d) =>
        d.lastCheck?.domainExpiresDaysRemaining !== null &&
        d.lastCheck?.domainExpiresDaysRemaining !== undefined &&
        d.lastCheck.domainExpiresDaysRemaining <= 0
    ).length;

    return c.json({
      total,
      expiringSoon,
      expired,
      healthy,
      unchecked,
      domainExpiringSoon,
      domainExpired,
      domains: allDomains,
    });
  });

  return app;
}

export const dashboardRouter = createDashboardRouter();
