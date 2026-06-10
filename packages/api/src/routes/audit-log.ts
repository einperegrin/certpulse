/**
 * Audit log admin route.
 *
 * Read-only listing of the `audit_log` table. Filterable on actor,
 * action, resource, and timestamp range. Paginated with `limit` and
 * `offset`. The same auth middleware that guards /api/* applies here,
 * so any caller is at least an api-token holder; v0.4 can layer an
 * admin-only role on top if a per-role ACL becomes a requirement.
 */
import { Hono } from "hono";
import { type DB, getDb } from "../db/index.js";
import { queryAudit, type AuditQuery } from "../services/audit.js";

type Env = {
  Variables: { db: DB };
};

export function createAuditLogRouter(db: DB = getDb()): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  app.get("/", (c) => {
    const q: AuditQuery = {};
    const actorType = c.req.query("actor_type");
    if (actorType === "user" || actorType === "api_token" || actorType === "system") {
      q.actorType = actorType;
    }
    const actorId = c.req.query("actor_id");
    if (actorId) q.actorId = actorId;
    const action = c.req.query("action");
    if (action) q.action = action;
    const resourceType = c.req.query("resource_type");
    if (resourceType) q.resourceType = resourceType;
    const resourceId = c.req.query("resource_id");
    if (resourceId) q.resourceId = resourceId;
    const since = c.req.query("since");
    if (since) q.since = since;
    const until = c.req.query("until");
    if (until) q.until = until;
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    if (!Number.isNaN(limit)) q.limit = limit;
    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    if (!Number.isNaN(offset)) q.offset = offset;

    const { rows, total } = queryAudit(db, q);
    return c.json({
      rows: rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        actorType: r.actorType,
        actorId: r.actorId,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        metadata: r.metadata,
      })),
      total,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  });

  return app;
}

export const auditLogRouter = createAuditLogRouter();
