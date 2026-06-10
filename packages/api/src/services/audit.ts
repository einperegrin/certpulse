/**
 * Audit log (v0.3).
 *
 * Tracks who did what to which resource. The schema is generic on
 * purpose: every row records (actor, action, resource, metadata) so
 * the UI can filter on any combination.
 *
 * `actorType` is "user" (a real person authenticated with a token),
 * "api_token" (a labelled api token), or "system" (jobs / migrations).
 * `actorId` is the token label for `api_token`, the remote IP for
 * unauthenticated login attempts, or "scheduler"/"migration" for
 * system actions.
 *
 * `action` is dotted: "domain.create", "domain.update", "domain.delete",
 * "channel.create", "channel.update", "channel.delete", "token.create",
 * "token.revoke", "auth.login.success", "auth.login.failure".
 *
 * `metadata` is JSON, currently used to capture (before, after) pairs
 * for updates and reason strings for deletes.
 */
import { and, desc, eq, gte, like, lte, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db/index.js";
import { auditLog } from "../db/schema.js";

export type ActorType = "user" | "api_token" | "system";

export interface AuditEntry {
  id?: number;
  timestamp?: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a single audit row. `metadata` is JSON-stringified by the
 * schema; we accept a plain object and let drizzle handle the
 * encoding. Caller passes the `DB` so this is testable without a
 * global.
 */
export function recordAudit(db: DB, entry: AuditEntry): void {
  db.insert(auditLog)
    .values({
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      metadata: entry.metadata,
    })
    .run();
}

/**
 * Query audit rows with optional filters. Pagination is offset-based
 * (good enough for an admin-only UI; if the table grows past 10k
 * rows we'll switch to keyset in v0.4). Returns newest first.
 */
export interface AuditQuery {
  actorType?: ActorType;
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  /** ISO-8601 inclusive lower bound on `timestamp`. */
  since?: string;
  /** ISO-8601 inclusive upper bound on `timestamp`. */
  until?: string;
  limit?: number;
  offset?: number;
}

export interface AuditRow {
  id: number;
  timestamp: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
}

export function queryAudit(db: DB, q: AuditQuery = {}): { rows: AuditRow[]; total: number } {
  const filters: SQL[] = [];
  if (q.actorType) filters.push(eq(auditLog.actorType, q.actorType));
  if (q.actorId) filters.push(eq(auditLog.actorId, q.actorId));
  // Action supports a SQL LIKE pattern (e.g. "domain.%" matches all
  // domain.* actions). Detected by the presence of a `%` wildcard.
  // The literal-equality case is `eq`; the wildcard case is `like`.
  if (q.action) {
    if (q.action.includes("%")) {
      filters.push(like(auditLog.action, q.action));
    } else {
      filters.push(eq(auditLog.action, q.action));
    }
  }
  if (q.resourceType) filters.push(eq(auditLog.resourceType, q.resourceType));
  if (q.resourceId) filters.push(eq(auditLog.resourceId, q.resourceId));
  if (q.since) filters.push(gte(auditLog.timestamp, q.since));
  if (q.until) filters.push(lte(auditLog.timestamp, q.until));

  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);

  const where = filters.length ? and(...filters) : undefined;

  const rows = db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.timestamp))
    .limit(limit)
    .offset(offset)
    .all() as AuditRow[];

  // Count for the same filter — needed by the UI's pager. We do a
  // separate count() rather than windowing because SQLite count with
  // LIMIT is two separate statements anyway.
  const totalRow = db
    .select({ c: sql<number>`count(*)` })
    .from(auditLog)
    .where(where)
    .all()[0];
  const total = Number(totalRow?.c ?? 0);

  return { rows, total };
}

/**
 * Retention prune: delete rows older than `retentionDays` days.
 *
 * ⚠️ This is the RETENTION helper — only the daily retention tick
 * should call it. It is exported (not internal) so a future
 * `certpulse audit prune --days N` CLI can wire to it, but no
 * request-time code path should ever invoke it. Doing so would
 * silently delete audit history. (Copilot review: audit.ts:148 —
 * "pruneAuditLog is exported and can be called by non-retention
 * paths".)
 *
 * Returns the number of rows removed. SQLite is serialised so the
 * count is accurate.
 */
export function pruneAuditLog(db: DB, retentionDays: number): number {
  // The schema stores `timestamp` as `datetime('now')` text. The
  // cutoff below is computed in the same format so the comparison
  // stays a plain lexicographic string compare inside SQLite.
  //
  // Sanitize retentionDays: clamp to a sane positive integer so a
  // 0 / negative / NaN / float call site can't compute a future
  // cutoff and silently wipe the whole audit history. (Copilot
  // review: audit.ts:154 — "retentionDays <= 0 will compute a
  // cutoff in the future and delete all audit rows".)
  const safeDays = Math.max(
    1,
    Math.floor(Number.isFinite(retentionDays) ? retentionDays : 1)
  );
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  const result = db
    .delete(auditLog)
    .where(lte(auditLog.timestamp, cutoff))
    .run();
  return result.changes;
}
