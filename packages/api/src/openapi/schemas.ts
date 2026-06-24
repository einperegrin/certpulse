/**
 * Shared Zod schemas for OpenAPI response models.
 *
 * These mirror the shapes returned by the route handlers. We keep them
 * alongside the registry so each route file does not have to re-declare
 * the same `Domain`, `Check`, `Channel`, `AuditLogRow` definitions.
 *
 * Note: the runtime data is produced by Drizzle (better-sqlite3), so
 * the schemas here describe the JSON shape that comes out of the
 * route — not the database row. Fields are intentionally permissive
 * (e.g. nullable strings) to match the actual payloads.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Domain                                                             */
/* ------------------------------------------------------------------ */

export const domainSchema = z
  .object({
    id: z.number().int(),
    hostname: z.string(),
    port: z.number().int(),
    enabled: z.boolean().optional().default(true),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .openapi("Domain");

export const checkSummarySchema = z
  .object({
    id: z.number().int().nullable().optional(),
    valid: z.boolean().nullable().optional(),
    daysRemaining: z.number().int().nullable().optional(),
    notAfter: z.string().nullable().optional(),
    issuer: z.string().nullable().optional(),
    issuerOrg: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    checkedAt: z.string().nullable().optional(),
    domainExpiresAt: z.string().nullable().optional(),
    domainExpiresDaysRemaining: z.number().int().nullable().optional(),
    domainRegistrar: z.string().nullable().optional(),
    domainRegistrarError: z.string().nullable().optional(),
  })
  .openapi("CheckSummary");

export const domainWithCheckSchema = z
  .object({
    domain: domainSchema,
    lastCheck: checkSummarySchema.nullable().optional(),
  })
  .openapi("DomainWithCheck");

/* ------------------------------------------------------------------ */
/* Check                                                              */
/* ------------------------------------------------------------------ */

export const checkSchema = z
  .object({
    id: z.number().int(),
    domainId: z.number().int(),
    valid: z.boolean().nullable().optional(),
    daysRemaining: z.number().int().nullable().optional(),
    notBefore: z.string().nullable().optional(),
    notAfter: z.string().nullable().optional(),
    issuer: z.string().nullable().optional(),
    issuerOrg: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    checkedAt: z.string().nullable().optional(),
    domainExpiresAt: z.string().nullable().optional(),
    domainExpiresDaysRemaining: z.number().int().nullable().optional(),
    domainRegistrar: z.string().nullable().optional(),
    domainRegistrarError: z.string().nullable().optional(),
  })
  .openapi("Check");

/* ------------------------------------------------------------------ */
/* Channel                                                            */
/* ------------------------------------------------------------------ */

export const channelConfigSchema = z
  .object({
    url: z.string().url().optional(),
    to: z.string().optional(),
    from: z.string().optional(),
    botToken: z.string().optional(),
    chatId: z.union([z.string(), z.number()]).optional(),
    topic: z.string().optional(),
    server: z.string().optional(),
    secret: z.string().optional(),
  })
  .openapi("ChannelConfig");

export const channelSchema = z
  .object({
    id: z.number().int(),
    domainId: z.number().int(),
    channel: z.enum(["email", "webhook", "telegram", "slack", "ntfy"]),
    enabled: z.boolean(),
    config: channelConfigSchema,
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .openapi("Channel");

/* ------------------------------------------------------------------ */
/* Audit log                                                          */
/* ------------------------------------------------------------------ */

export const auditLogRowSchema = z
  .object({
    id: z.number().int(),
    timestamp: z.string(),
    actorType: z.string(),
    actorId: z.string(),
    action: z.string(),
    resourceType: z.string(),
    resourceId: z.string().nullable().optional(),
    metadata: z.unknown().nullable().optional(),
  })
  .openapi("AuditLogRow");

/* ------------------------------------------------------------------ */
/* Dashboard                                                          */
/* ------------------------------------------------------------------ */

export const dashboardSchema = z
  .object({
    total: z.number().int(),
    expiringSoon: z.number().int(),
    expired: z.number().int(),
    healthy: z.number().int(),
    unchecked: z.number().int(),
    // v0.5: a domain whose check ran but failed for reasons OTHER
    // than `daysRemaining <= 0` (e.g. self-signed, hostname
    // mismatch, OCSP-revoked). `revoked` is a sub-bucket of `invalid`
    // — the dashboard UI surfaces it as a specific badge. (Roman's
    // request: revoked certs must NOT appear as healthy.)
    invalid: z.number().int().optional(),
    revoked: z.number().int().optional(),
    domainExpiringSoon: z.number().int(),
    domainExpired: z.number().int(),
    domains: z.array(z.unknown()),
  })
  .openapi("Dashboard");

/* ------------------------------------------------------------------ */
/* Generic error envelope                                             */
/* ------------------------------------------------------------------ */

export const errorSchema = z
  .object({
    error: z.string(),
    details: z.unknown().optional(),
    hint: z.string().optional(),
  })
  .openapi("Error");

/* ------------------------------------------------------------------ */
/* Health                                                             */
/* ------------------------------------------------------------------ */

export const liveSchema = z
  .object({ status: z.string(), ts: z.string() })
  .openapi("Liveness");

export const readySchema = z
  .object({
    status: z.string(),
    timestamp: z.string(),
    checks: z.object({
      db: z.string(),
      last_check_age_seconds: z.number().nullable().optional(),
      last_alert_age_seconds: z.number().nullable().optional(),
    }),
  })
  .openapi("Readiness");

export const configSchema = z
  .object({
    checkIntervalMinutes: z.number().int(),
    hasResend: z.boolean(),
  })
  .openapi("Config");
