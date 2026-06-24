import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { type DB, getDb } from "../db/index.js";
import { checks } from "../db/schema.js";
import { openApiRegistry } from "../openapi/registry.js";
import { z } from "zod";
import { toIsoString } from "../lib/datetime.js";

export function createChecksRouter(db: DB = getDb()): Hono {
  const app = new Hono();

  // Register the /api/checks path on the OpenAPI registry. The runtime
  // handler is unchanged — we just hand the library a `describeRoute`
  // config so the generated spec documents the response shape and the
  // `domain_id` / `limit` query parameters.
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/checks",
    summary: "List SSL check history",
    tags: ["checks"],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        domain_id: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
    },
    responses: {
      200: {
        description: "List of check rows, newest first",
        content: {
          "application/json": {
            schema: z.object({ checks: z.array(z.unknown()) }),
          },
        },
      },
    },
  });

  // v0.5 timezone fix: SQLite datetimes are stored as
  // `YYYY-MM-DD HH:MM:SS` UTC (no `Z`). Rewrite every datetime-shaped
  // leaf on the way out so the frontend gets proper ISO 8601
  // (otherwise `new Date("…")` parses them as local time in a UTC+2
  // browser and "Last Check" reads "2h ago" the moment a row is
  // inserted). `notBefore` / `notAfter` are already ISO —
  // `toIsoString` passes them through unchanged.
  const serialize = (c: typeof checks.$inferSelect) => ({
    id: c.id,
    domainId: c.domainId,
    valid: c.valid,
    issuer: c.issuer,
    issuerOrg: c.issuerOrg,
    serial: c.serial,
    notBefore: toIsoString(c.notBefore),
    notAfter: toIsoString(c.notAfter),
    daysRemaining: c.daysRemaining,
    error: c.error,
    rawPem: c.rawPem,
    checkedAt: toIsoString(c.checkedAt),
    domainExpiresAt: toIsoString(c.domainExpiresAt),
    domainExpiresDaysRemaining: c.domainExpiresDaysRemaining,
    domainRegistrar: c.domainRegistrar,
    domainRegistrarError: c.domainRegistrarError,
  });

  app.get("/", (c) => {
    const domainIdParam = c.req.query("domain_id");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 500);
    if (domainIdParam) {
      const domainId = parseInt(domainIdParam, 10);
      if (Number.isNaN(domainId)) return c.json({ error: "Invalid domain_id" }, 400);
      const rows = db
        .select()
        .from(checks)
        .where(eq(checks.domainId, domainId))
        .orderBy(desc(checks.checkedAt))
        .limit(limit)
        .all();
      return c.json({ checks: rows.map(serialize) });
    }
    const rows = db
      .select()
      .from(checks)
      .orderBy(desc(checks.checkedAt))
      .limit(limit)
      .all();
    return c.json({ checks: rows.map(serialize) });
  });

  return app;
}

export const checksRouter = createChecksRouter();
