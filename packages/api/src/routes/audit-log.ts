/**
 * Audit log admin route.
 *
 * Read-only listing of the `audit_log` table. Filterable on actor,
 * action, resource, and timestamp range. Paginated with `limit` and
 * `offset`. The same auth middleware that guards /api/* applies here,
 * so any caller is at least an api-token holder; v0.4 can layer an
 * admin-only role on top if a per-role ACL becomes a requirement.
 *
 * The DB is closed over from `createAuditLogRouter(db)` — the
 * previous `app.use("*", c.set("db", db))` middleware (Copilot
 * review: audit-log.ts:24) was dead code, since none of the handlers
 * ever read it back. We removed it.
 */
import { Hono } from "hono";
import { z } from "zod";
import { type DB, getDb } from "../db/index.js";
import { queryAudit, type AuditQuery } from "../services/audit.js";
import { openApiRegistry } from "../openapi/registry.js";
import { auditLogRowSchema } from "../openapi/schemas.js";
import { toIsoString } from "../lib/datetime.js";

export function createAuditLogRouter(db: DB = getDb()): Hono {
  const app = new Hono();

  // /api/audit-log — read-only listing of the `audit_log` table.
  // Filterable on actor / action / resource / timestamp. The
  // `metadata` field is intentionally `z.unknown()` because each
  // action writes its own payload shape (domain.create writes
  // {hostname, port}; channel.update writes {domainId, enabled,
  // configChanged}; etc.). Documenting every variant is out of
  // scope for v0.4.
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/audit-log",
    summary: "List audit log entries",
    tags: ["audit"],
    security: [{ bearerAuth: [] }],
    request: {
      query: z.object({
        actor_type: z.enum(["user", "api_token", "system"]).optional(),
        actor_id: z.string().optional(),
        action: z.string().optional(),
        resource_type: z.string().optional(),
        resource_id: z.string().optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
    },
    responses: {
      200: {
        description: "Paged audit rows, newest first",
        content: {
          "application/json": {
            schema: z.object({
              rows: z.array(auditLogRowSchema),
              total: z.number().int(),
              limit: z.number().int(),
              offset: z.number().int(),
            }),
          },
        },
      },
    },
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
    // v0.5 timezone fix: `audit_log.timestamp` is stored as SQLite
    // datetime (`YYYY-MM-DD HH:MM:SS`, no `Z`). Rewrite to ISO 8601
    // on the way out so the audit log renders "just now" instead of
    // "2h ago" in a non-UTC browser.
    return c.json({
      rows: rows.map((r) => ({
        id: r.id,
        timestamp: toIsoString(r.timestamp),
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
