import { sql } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

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
