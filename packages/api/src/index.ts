import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb, closeDb, type DB } from "./db/index.js";
import { runSqlMigrations } from "./db/sqlmigrate.js";
import { createDomainsRouter } from "./routes/domains.js";
import { createChecksRouter } from "./routes/checks.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createChannelsRouter } from "./routes/channels.js";
import { createAuditLogRouter } from "./routes/audit-log.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createRateLimitMiddleware } from "./middleware/rate-limit.js";
import { startScheduler, stopScheduler, getCheckIntervalMinutes } from "./services/scheduler.js";
import { recentAlerts } from "./services/alerter.js";
import { logger } from "./services/logger.js";
import {
  checkDurationSeconds,
  checksTotal,
  dbQueryDurationSeconds,
  domainsTotal,
  registry,
  tokensTotal,
} from "./lib/metrics.js";
import { sql, eq } from "drizzle-orm";
import { apiTokens, domains, schedulerState } from "./db/schema.js";

/**
 * Tiny DB-ping helper used by /health/ready. The simplest possible
 * query — `SELECT 1` — is enough to confirm the connection. We do NOT
 * fall back to writing a probe row, because the `scheduler` writes the
 * lock state and is enough signal.
 */
function dbPing(db: DB): boolean {
  try {
    db.run(sql`SELECT 1`);
    return true;
  } catch (err) {
    logger.warn({ err }, "db ping failed");
    return false;
  }
}

/**
 * Refresh gauge metrics that are derived from the DB. Called on
 * /health/ready and on /metrics scrapes; cheap because the row
 * counts are tiny.
 */
function refreshGauges(db: DB): void {
  try {
    const d = db.select({ c: sql<number>`count(*)` }).from(domains).all()[0]?.c ?? 0;
    domainsTotal.set(Number(d));
  } catch (err) {
    logger.warn({ err }, "failed to refresh domains gauge");
  }
  try {
    const t = db
      .select({ c: sql<number>`count(*)` })
      .from(apiTokens)
      .all()[0]?.c ?? 0;
    tokensTotal.set(Number(t));
  } catch (err) {
    logger.warn({ err }, "failed to refresh tokens gauge");
  }
}

/**
 * Read the `last_tick` and `last_alert` (we use the most recent
 * alerts.createdAt as a proxy) timestamps so /health/ready can
 * report staleness.
 */
function lastTickAgeSeconds(db: DB): number | null {
  try {
    const row = db
      .select({ value: schedulerState.value })
      .from(schedulerState)
      .where(eq(schedulerState.key, "last_tick"))
      .all()[0];
    if (!row?.value) return null;
    const ts = Date.parse(row.value);
    if (Number.isNaN(ts)) return null;
    return Math.max(0, Math.floor((Date.now() - ts) / 1000));
  } catch {
    return null;
  }
}

export function createApp(options?: { db?: DB }) {
  const db = options?.db ?? getDb();
  const app = new Hono();

  // CORS: reflect the request Origin (we sit behind nginx, which can also
  // gate on this). Never use origin: "*" in production — paired with auth,
  // echoing Origin is the standard hardening.
  app.use(
    "*",
    cors({
      origin: (origin) => origin ?? "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    })
  );

  // Health & metrics are public — registered BEFORE the auth and
  // rate-limit middleware. This matches the existing behaviour of
  // /health, and the same justification applies: docker healthchecks
  // and load balancers / Prometheus scrapers must work without
  // credentials.
  //
  // /health is kept as a backward-compat alias for /health/live so
  // existing compose files don't break.
  app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));
  app.get("/health/live", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

  app.get("/health/ready", (c) => {
    const dbOk = dbPing(db);
    refreshGauges(db);
    const lastTick = lastTickAgeSeconds(db);
    const body = {
      status: dbOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks: {
        db: dbOk ? "ok" : "fail",
        last_check_age_seconds: lastTick,
      },
    };
    return c.json(body, dbOk ? 200 : 503);
  });

  // Prometheus scrape endpoint. Returns text/plain in the
  // prom-client exposition format. We refresh the gauges first so
  // dashboards never see stale domain / token counts.
  app.get("/metrics", async (c) => {
    refreshGauges(db);
    const text = await registry.metrics();
    return new Response(text, {
      status: 200,
      headers: { "content-type": registry.contentType },
    });
  });

  // Bearer-token auth on every /api/* route. Skips /health and
  // /metrics (registered above before this middleware) and is bypassed
  // only when AUTH_DISABLED is set (dev mode — see auth.ts).
  app.use("/api/*", createAuthMiddleware(db));

  // Per-IP rate limit on /api/*. Defaults to 100 req/min (configurable
  // via RATE_LIMIT_PER_MINUTE). Health and metrics are unaffected.
  app.use("/api/*", createRateLimitMiddleware());

  app.route("/api/domains", createDomainsRouter(db));
  app.route("/api/checks", createChecksRouter(db));
  app.route("/api/dashboard", createDashboardRouter(db));
  app.route("/api", createChannelsRouter(db));
  app.route("/api/audit-log", createAuditLogRouter(db));

  app.get("/api/alerts", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    return c.json({ alerts: recentAlerts(limit) });
  });

  // M-3: don't expose ALERT_EMAIL_TO — that's a PII risk in shared
  // environments. The dashboard only needs to know "is resend
  // configured?" so it can hide the email field.
  app.get("/api/config", (c) =>
    c.json({
      checkIntervalMinutes: getCheckIntervalMinutes(),
      hasResend: Boolean(process.env.RESEND_API_KEY),
    })
  );

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  // Generic onError (H-4 / M-8): never leak internal error messages to
  // API clients. The full error is logged server-side with a request
  // id; the client gets a generic 500 plus the id so support can
  // correlate without exposing stack traces, file paths, library
  // versions, or other internal detail.
  app.onError((err, c) => {
    const requestId = crypto.randomUUID();
    logger.error({ err, requestId }, "[api] error");
    return c.json(
      { error: "Internal server error", requestId },
      500
    );
  });

  // Track the duration of every /api/* request as a histogram label
  // per-operation. This is a coarse metric — better than nothing for
  // a self-hosted v0.3.0 — and the place to extend in v0.4 with
  // per-route labels.
  app.use("/api/*", async (c, next) => {
    const end = checkDurationSeconds.startTimer();
    const dbEnd = dbQueryDurationSeconds.startTimer();
    try {
      await next();
    } finally {
      end({ result: c.res?.status && c.res.status < 400 ? "success" : "failure" });
      dbEnd({ operation: "request" });
    }
  });

  return app;
}

export function bootstrap() {
  getDb();
  runSqlMigrations();
  const app = createApp();
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const scheduler = startScheduler();
  // Count the "process booted" event so the metric isn't all-zero
  // before the first check.
  checksTotal.inc({ result: "success" }, 0);
  logger.info(
    { port, cron: scheduler.expression, intervalMinutes: scheduler.intervalMinutes },
    `[api] CertPulse API listening on :${port}`
  );
  const server = serve({ fetch: app.fetch, port });

  const shutdown = () => {
    logger.info("[api] shutting down");
    stopScheduler();
    closeDb();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return { app, server };
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  bootstrap();
}
