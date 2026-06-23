import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type DB, getDb } from "../db/index.js";
import { checks, domains } from "../db/schema.js";
import { openApiRegistry } from "../openapi/registry.js";
import { dashboardSchema } from "../openapi/schemas.js";
import { toIsoString } from "../lib/datetime.js";

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

    // Bug #2 fix: a cert whose TLS handshake failed (e.g. expired,
    // revoked, self-signed) still reports a populated `notAfter` /
    // `daysRemaining` because the checker now connects with
    // `rejectUnauthorized: false` and reads the cert first. So
    // `daysRemaining <= 0` continues to be the right signal for
    // "expired". A revoked-but-not-yet-expired cert, however, has a
    // positive `daysRemaining` AND `valid: false` AND an `error`
    // code — so we add a dedicated `invalid` bucket (and surface
    // `revoked` when the OCSP stapling path flagged it).
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
        d.lastCheck?.valid === true &&
        d.lastCheck?.daysRemaining !== null &&
        d.lastCheck?.daysRemaining !== undefined &&
        d.lastCheck.daysRemaining > 30
    ).length;
    // `unchecked` = no `checks` row yet (brand-new domain, or the
    // first scheduled run hasn't happened). Different from `invalid`
    // — a row exists but it reports the cert is bad.
    const unchecked = allDomains.filter((d) => !d.lastCheck).length;
    // `invalid` = a check ran, the cert was unparseable / untrusted /
    // self-signed / hostname-mismatched, etc. `revoked` is a
    // sub-bucket of `invalid` so the UI can render a specific badge.
    const invalid = allDomains.filter(
      (d) => d.lastCheck && d.lastCheck.valid === false
    ).length;
    const revoked = allDomains.filter(
      (d) => d.lastCheck?.error === "cert_revoked"
    ).length;

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

    // Bug #1 fix: every SQLite datetime the dashboard returns was
    // stored as `YYYY-MM-DD HH:MM:SS` UTC (no `Z`). Without the
    // rewrite, `new Date("2026-06-23 15:30:00")` in a UTC+2 browser
    // becomes 13:30 UTC and "Last Check" reads "2h ago". Map every
    // domain row through `toIsoString` on the way out.
    const serializedDomains = allDomains.map((d) => ({
      id: d.id,
      hostname: d.hostname,
      port: d.port,
      enabled: d.enabled,
      lastCheck: d.lastCheck
        ? {
            id: d.lastCheck.id,
            valid: d.lastCheck.valid,
            daysRemaining: d.lastCheck.daysRemaining,
            notAfter: toIsoString(d.lastCheck.notAfter),
            issuer: d.lastCheck.issuer,
            issuerOrg: d.lastCheck.issuerOrg,
            error: d.lastCheck.error,
            checkedAt: toIsoString(d.lastCheck.checkedAt),
            domainExpiresAt: toIsoString(d.lastCheck.domainExpiresAt),
            domainExpiresDaysRemaining:
              d.lastCheck.domainExpiresDaysRemaining,
            domainRegistrar: d.lastCheck.domainRegistrar,
            domainRegistrarError: d.lastCheck.domainRegistrarError,
          }
        : null,
    }));

    return c.json({
      total,
      expiringSoon,
      expired,
      healthy,
      unchecked,
      invalid,
      revoked,
      domainExpiringSoon,
      domainExpired,
      domains: serializedDomains,
    });
  });

  return app;
}

export const dashboardRouter = createDashboardRouter();
