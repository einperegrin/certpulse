import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { type DB, getDb } from "../db/index.js";
import { checks } from "../db/schema.js";

export function createChecksRouter(db: DB = getDb()): Hono {
  const app = new Hono();

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
      return c.json({ checks: rows });
    }
    const rows = db
      .select()
      .from(checks)
      .orderBy(desc(checks.checkedAt))
      .limit(limit)
      .all();
    return c.json({ checks: rows });
  });

  return app;
}

export const checksRouter = createChecksRouter();
