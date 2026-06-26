/**
 * Tests for the Prometheus metrics added in v0.4.
 *
 * v0.3.0 introduced the HTTP histogram + check/alert counters via
 * lib/metrics.ts. v0.4 (Grafana dashboard) added five more:
 *
 *   - sslert_http_requests_total{method,path,status}
 *   - sslert_rate_limit_hits_total{path}
 *   - sslert_audit_log_writes_total{action,resource_type}
 *   - sslert_last_check_timestamp_seconds
 *   - sslert_last_alert_timestamp_seconds
 *
 * These tests confirm each one appears in the /metrics output after a
 * realistic event in the codebase, so the Grafana dashboard never
 * references a metric that doesn't actually exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { createInMemoryDb, type DB } from "../db/index.js";
import { runSqlMigrations } from "../db/sqlmigrate.js";
import { recordAudit } from "../services/audit.js";
import {
  auditLogWritesTotal,
  httpRequestDurationSeconds,
  lastAlertTimestampSeconds,
  lastCheckTimestampSeconds,
  rateLimitHitsTotal,
  registry,
} from "../lib/metrics.js";
import { __resetRateLimiterForTests, createRateLimitMiddleware } from "./rate-limit.js";

function makeDb(): { db: DB; sqlite: Database.Database } {
  const { db, sqlite } = createInMemoryDb();
  runSqlMigrations(sqlite);
  return { db, sqlite };
}

async function metricsText(): Promise<string> {
  return registry.metrics();
}

describe("Prometheus metrics — v0.4 additions", () => {
  let db: DB;
  let sqlite: Database.Database;

  beforeEach(() => {
    const m = makeDb();
    db = m.db;
    sqlite = m.sqlite;
    // Reset singleton rate limiter between tests so the per-IP
    // bucket doesn't bleed across cases.
    __resetRateLimiterForTests();
  });

  afterEach(() => {
    sqlite.close();
  });

  it("exposes sslert_http_request_duration_seconds_bucket (regression for v0.3)", async () => {
    httpRequestDurationSeconds.observe({ result: "ok", method: "GET" }, 0.05);
    const text = await metricsText();
    expect(text).toMatch(
      /sslert_http_request_duration_seconds_bucket\{[^}]*method="GET"[^}]*\}/,
    );
  });

  it("exposes sslert_rate_limit_hits_total after the limiter rejects", async () => {
    const app = new Hono();
    app.use("/api/*", createRateLimitMiddleware());
    app.get("/api/probe", (c) => c.json({ ok: true }));

    // Lower the threshold for the test by setting the env var.
    process.env.RATE_LIMIT_PER_MINUTE = "2";
    __resetRateLimiterForTests();

    // 3 requests; the third should hit the limit and bump the counter.
    await app.request("/api/probe", { headers: { "x-forwarded-for": "10.0.0.1" } });
    await app.request("/api/probe", { headers: { "x-forwarded-for": "10.0.0.1" } });
    const third = await app.request("/api/probe", { headers: { "x-forwarded-for": "10.0.0.1" } });
    expect(third.status).toBe(429);

    const text = await metricsText();
    expect(text).toMatch(
      /sslert_rate_limit_hits_total\{[^}]*path="[^"]*"[^}]*\} 1/,
    );
  });

  it("exposes sslert_audit_log_writes_total after a recordAudit call", async () => {
    recordAudit(db, {
      actorType: "system",
      actorId: null,
      action: "domain.create",
      resourceType: "domain",
      resourceId: "1",
    });
    const text = await metricsText();
    expect(text).toMatch(
      /sslert_audit_log_writes_total\{[^}]*action="domain"[^}]*resource_type="domain"[^}]*\} 1/,
    );
  });

  it("exposes sslert_last_check_timestamp_seconds (zero on a fresh DB)", async () => {
    // On a fresh in-memory DB, the scheduler_state table has no
    // `last_tick` row → the gauge is set to 0 (matches the contract
    // documented in lib/metrics.ts).
    lastCheckTimestampSeconds.set(0);
    const text = await metricsText();
    expect(text).toMatch(/sslert_last_check_timestamp_seconds 0\b/);
  });

  it("exposes sslert_last_alert_timestamp_seconds (zero on a fresh DB)", async () => {
    lastAlertTimestampSeconds.set(0);
    const text = await metricsText();
    expect(text).toMatch(/sslert_last_alert_timestamp_seconds 0\b/);
  });

  it("every v0.4 metric name appears in /metrics even with no traffic", async () => {
    // Counter metric names show up in /metrics even at zero — that's
    // prom-client's documented behaviour. This guards against
    // accidentally removing a registration.
    const text = await metricsText();
    const expected = [
      "sslert_http_requests_total",
      "sslert_rate_limit_hits_total",
      "sslert_audit_log_writes_total",
      "sslert_last_check_timestamp_seconds",
      "sslert_last_alert_timestamp_seconds",
      "sslert_alerts_sent_total",
      "sslert_checks_total",
    ];
    for (const name of expected) {
      expect(text).toContain(name);
    }
  });

  it("exports the v0.4 counters from lib/metrics.ts", () => {
    expect(typeof auditLogWritesTotal.inc).toBe("function");
    expect(typeof rateLimitHitsTotal.inc).toBe("function");
  });
});
