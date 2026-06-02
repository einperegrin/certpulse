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
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  domainId: integer("domain_id")
    .notNull()
    .references(() => domains.id, { onDelete: "cascade" }),
  checkId: integer("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  level: text("level").notNull(),
  type: text("type").notNull().default("email"),
  status: text("status").notNull().default("pending"),
  sentAt: text("sent_at"),
  error: text("error"),
  createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
});

export type Domain = typeof domains.$inferSelect;
export type NewDomain = typeof domains.$inferInsert;
export type Check = typeof checks.$inferSelect;
export type NewCheck = typeof checks.$inferInsert;
export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
