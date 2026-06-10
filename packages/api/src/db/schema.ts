import { sql } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

/**
 * SQL injection audit (v0.3 / GHSA-gpj5-g38j-94v9).
 *
 * The high-severity advisory for `drizzle-orm <0.45.2` is about
 * `sql.raw` and dynamic identifier interpolation. This codebase
 * intentionally avoids both:
 *
 *  - `sql.raw(...)` is **not used anywhere**. We only use the tagged
 *    template `sql\`...${colRef}...\`` form. Column references passed
 *    through `${...}` are escaped by drizzle (they are not inlined
 *    as raw identifiers).
 *  - Identifiers (table / column names) are always referenced via
 *    the typed `drizzle-orm/sqlite-core` builders (`sqliteTable`,
 *    `text("col_name")`, `integer("col_name")`, `from(domains)`,
 *    `eq(domains.id, x)`, `desc(checks.checkedAt)`), never via
 *    string concatenation.
 *  - The only string-into-SQL entry points are:
 *      (a) column defaults using `sql\`(datetime('now'))\`` — a
 *          fixed literal, no interpolation.
 *      (b) the dashboard's `leftJoin` on the latest check, where
 *          the right-hand side is `sql\`(SELECT id FROM checks
 *          WHERE domain_id = domains.id ORDER BY checked_at DESC
 *          LIMIT 1)\`` — a fixed literal subquery, no
 *          interpolation.
 *      (c) `VACUUM` in `jobs/retention.ts` — a fixed literal, no
 *          interpolation.
 *
 * No user input is ever interpolated into SQL. The audit fix in
 * v0.3 is therefore "no code change required; documented above",
 * consistent with the task brief.
 */

export const domains = sqliteTable("domains", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hostname: text("hostname").notNull().unique(),
  port: integer("port").default(443).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
});

export const checks = sqliteTable("checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  domainId: integer("domain_id")
    .notNull()
    .references(() => domains.id, { onDelete: "cascade" }),
  checkedAt: text("checked_at").default(sql`(datetime('now'))`).notNull(),
  valid: integer("valid", { mode: "boolean" }).notNull(),
  issuer: text("issuer"),
  issuerOrg: text("issuer_org"),
  serial: text("serial"),
  notBefore: text("not_before"),
  notAfter: text("not_after"),
  daysRemaining: integer("days_remaining"),
  error: text("error"),
  rawPem: text("raw_pem"),
  // Domain registration expiry (from RDAP/WHOIS lookup)
  domainExpiresAt: text("domain_expires_at"),
  domainExpiresDaysRemaining: integer("domain_expires_days_remaining"),
  domainRegistrar: text("domain_registrar"),
  domainRegistrarError: text("domain_registrar_error"),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  domainId: integer("domain_id")
    .notNull()
    .references(() => domains.id, { onDelete: "cascade" }),
  checkId: integer("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  // "cert" = certificate expiry, "domain" = domain registration expiry
  source: text("source").notNull().default("cert"),
  level: text("level").notNull(),
  // "email" | "webhook" | "telegram" | "slack" | "ntfy"
  channel: text("channel").notNull().default("email"),
  status: text("status").notNull().default("pending"),
  sentAt: text("sent_at"),
  error: text("error"),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
});

/**
 * Per-domain alert channel configuration.
 * Stores the per-channel target/credentials as a JSON blob in `config`
 * so the schema doesn't need a column per channel.
 */
export const alertChannels = sqliteTable("alert_channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  domainId: integer("domain_id")
    .notNull()
    .references(() => domains.id, { onDelete: "cascade" }),
  // "email" | "webhook" | "telegram" | "slack" | "ntfy"
  channel: text("channel").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  // JSON-encoded config: { url, botToken, chatId, topic, ... }
  config: text("config").notNull().default("{}"),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
});

export const apiTokens = sqliteTable("api_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
  expiresAt: text("expires_at"),
  lastUsedAt: text("last_used_at"),
});

export type Domain = typeof domains.$inferSelect;
export type NewDomain = typeof domains.$inferInsert;
export type Check = typeof checks.$inferSelect;
export type NewCheck = typeof checks.$inferInsert;
export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
export type AlertChannel = typeof alertChannels.$inferSelect;
export type NewAlertChannel = typeof alertChannels.$inferInsert;
export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;

/**
 * Generic key/value store for scheduler state (last tick, retention
 * timestamp, etc.) — see Task 2.2 (H-3) and Task 2.4 (M-1).
 */
export const schedulerState = sqliteTable("scheduler_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`).notNull(),
});

export type SchedulerState = typeof schedulerState.$inferSelect;
export type NewSchedulerState = typeof schedulerState.$inferInsert;

/**
 * Audit log (v0.3). One row per state-changing action (domain /
 * channel / token CRUD, auth attempts). See `services/audit.ts` for
 * the writer / reader API.
 */
export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: text("timestamp").default(sql`(datetime('now'))`).notNull(),
  // "user" | "api_token" | "system"
  actorType: text("actor_type").notNull(),
  // Token label, remote IP, or "scheduler"/"migration" for system actors.
  actorId: text("actor_id"),
  // Dotted action name: "domain.create", "auth.login.failure", etc.
  action: text("action").notNull(),
  // "domain" | "channel" | "token" | "auth"
  resourceType: text("resource_type").notNull(),
  // Hostname, channel id, token id, etc. — string form, since the
  // resource may be identified by something other than an int.
  resourceId: text("resource_id"),
  // JSON-encoded. Captures (before, after) for updates, reason for
  // deletes, or a free-form payload for login attempts.
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown> | null>(),
});

export type AuditLog = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
