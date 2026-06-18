import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
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
  dbQueryDurationSeconds,
  domainsTotal,
  httpRequestDurationSeconds,
  lastAlertTimestampSeconds,
  lastCheckTimestampSeconds,
  registry,
  tokensTotal,
} from "./lib/metrics.js";
import { buildOpenApiDocument, openApiRegistry, z } from "./openapi/registry.js";
import { sql, eq, desc } from "drizzle-orm";
import { alerts, apiTokens, domains, schedulerState } from "./db/schema.js";

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
 *
 * v0.4: also refreshes `certpulse_last_check_timestamp_seconds` and
 * `certpulse_last_alert_timestamp_seconds` so the Grafana "last check
 * age" / "last alert age" gauges always reflect the current state of
 * the DB at scrape time (the scheduler does NOT set them inline — a
 * missed tick would otherwise leave a stale value). (v0.4 / Grafana
 * panels 6 + 7.)
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
  try {
    const row = db
      .select({ value: schedulerState.value })
      .from(schedulerState)
      .where(eq(schedulerState.key, "last_tick"))
      .all()[0];
    if (row?.value) {
      const ts = Date.parse(row.value);
      lastCheckTimestampSeconds.set(Number.isNaN(ts) ? 0 : Math.floor(ts / 1000));
    } else {
      lastCheckTimestampSeconds.set(0);
    }
  } catch (err) {
    logger.warn({ err }, "failed to refresh last_check gauge");
  }
  try {
    const row = db
      .select({ createdAt: alerts.createdAt })
      .from(alerts)
      .orderBy(desc(alerts.createdAt))
      .limit(1)
      .all()[0];
    if (row?.createdAt) {
      // Schema uses `datetime('now')` (space-separated) — try ISO first,
      // fall back to the SQLite format. Either way, NaN => 0 so the
      // gauge is never undefined.
      let ts = Date.parse(row.createdAt);
      if (Number.isNaN(ts)) ts = Date.parse(row.createdAt.replace(" ", "T") + "Z");
      lastAlertTimestampSeconds.set(Number.isNaN(ts) ? 0 : Math.floor(ts / 1000));
    } else {
      lastAlertTimestampSeconds.set(0);
    }
  } catch (err) {
    logger.warn({ err }, "failed to refresh last_alert gauge");
  }
}

/**
 * Read the `last_tick` and `last_alert` timestamps so /health/ready
 * can report staleness. `last_tick` is the last time the scheduler
 * claim was updated (a successful tick). `last_alert` is the most
 * recent row in `alerts` — a proxy for "did the alerter actually
 * dispatch something recently".
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

function lastAlertAgeSeconds(db: DB): number | null {
  try {
    const row = db
      .select({ createdAt: alerts.createdAt })
      .from(alerts)
      .orderBy(desc(alerts.createdAt))
      .limit(1)
      .all()[0];
    if (!row?.createdAt) return null;
    // `alerts.createdAt` is stored via `datetime('now')` text in the
    // schema — try parsing as ISO first, fall back to replacing the
    // SQLite-formatted space separator. Either way, return null on
    // NaN so /health/ready reports "never alerted" rather than 0.
    let ts = Date.parse(row.createdAt);
    if (Number.isNaN(ts)) {
      ts = Date.parse(row.createdAt.replace(" ", "T") + "Z");
    }
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
  // existing compose files don't break. Both endpoints return the
  // SAME shape (`{status, ts}`) so monitoring tooling that switches
  // from one to the other is not surprised.
  app.get("/health", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));
  app.get("/health/live", (c) => c.json({ status: "ok", ts: new Date().toISOString() }));

  app.get("/health/ready", (c) => {
    const dbOk = dbPing(db);
    refreshGauges(db);
    const lastTick = lastTickAgeSeconds(db);
    const lastAlert = lastAlertAgeSeconds(db);
    const body = {
      status: dbOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks: {
        db: dbOk ? "ok" : "fail",
        last_check_age_seconds: lastTick,
        last_alert_age_seconds: lastAlert,
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

  // OpenAPI spec + Swagger UI. Mounted BEFORE auth and rate-limit so
  // the spec is publicly browsable (this is the whole point of a
  // machine-readable spec — tools fetch it without a token, then use
  // the token to call the real endpoints).
  //
  // The spec is generated on demand from the OpenAPI registry: every
  // route that has registered `describeRoute(...)` contributes a path.
  // Caching would matter at scale; for a self-hosted monitor with a
  // handful of routes, the cost of regeneration is negligible.
  app.get("/api/openapi.json", (c) => {
    const url = new URL(c.req.url);
    const base = `${url.protocol}//${url.host}`;
    const doc = buildOpenApiDocument(base);
    return c.json(doc);
  });
  app.get(
    "/api/docs",
    swaggerUI({
      url: "/api/openapi.json",
      title: "CertPulse API — Swagger UI",
    })
  );

  // Document the public-utility endpoints (health, metrics, openapi,
  // swagger UI) so the spec is complete. They are tagged
  // "infrastructure" and explicitly carry `security: []` so callers
  // know they are exempt from Bearer auth.
  openApiRegistry.registerPath({
    method: "get",
    path: "/health/live",
    tags: ["infrastructure"],
    summary: "Liveness probe (no auth)",
    security: [],
    responses: { 200: { description: "Process is up" } },
  });
  openApiRegistry.registerPath({
    method: "get",
    path: "/health/ready",
    tags: ["infrastructure"],
    summary: "Readiness probe — DB ping + last-tick/last-alert ages (no auth)",
    security: [],
    responses: {
      200: { description: "DB reachable" },
      503: { description: "DB unreachable" },
    },
  });
  openApiRegistry.registerPath({
    method: "get",
    path: "/metrics",
    tags: ["infrastructure"],
    summary: "Prometheus scrape endpoint (no auth)",
    security: [],
    responses: {
      200: {
        description: "prom-client text format",
        content: { "text/plain": { schema: { type: "string" } } },
      },
    },
  });
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/openapi.json",
    tags: ["infrastructure"],
    summary: "This OpenAPI document (no auth)",
    security: [],
    responses: { 200: { description: "OpenAPI 3.1 JSON document" } },
  });
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/docs",
    tags: ["infrastructure"],
    summary: "Swagger UI for this OpenAPI document (no auth)",
    security: [],
    responses: { 200: { description: "HTML page rendering the Swagger UI" } },
  });

  // Bearer-token auth on every /api/* route. Skips /health and
  // /metrics (registered above before this middleware) and is bypassed
  // only when AUTH_DISABLED is set (dev mode — see auth.ts).
  //
  // Mounted AFTER rate-limit so that a flood of unauthenticated
  // requests can't burn DB CPU on `api_tokens` lookups. (Copilot
  // review: index.ts:147 — "rate-limit mounted after auth" — same
  // security boundary, just reversed so unauthed bursts can't
  // saturate the auth path before being throttled.)
  app.use("/api/*", createRateLimitMiddleware());
  app.use("/api/*", createAuthMiddleware(db));

  app.route("/api/domains", createDomainsRouter(db));
  app.route("/api/checks", createChecksRouter(db));
  app.route("/api/dashboard", createDashboardRouter(db));
  app.route("/api", createChannelsRouter(db));
  app.route("/api/audit-log", createAuditLogRouter(db));

  app.get("/api/alerts", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    return c.json({ alerts: recentAlerts(limit) });
  });
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/alerts",
    tags: ["alerts"],
    summary: "Recent alert dispatches (in-memory ring buffer)",
    security: [{ bearerAuth: [] }],
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) },
    responses: { 200: { description: "OK" } },
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
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/config",
    tags: ["config"],
    summary: "Public runtime config (check interval, resend presence)",
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: "OK" } },
  });

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

  // Track the duration of every /api/* request. v0.3 records a single
  // histogram with `result` and `method` labels — the previous code
  // accidentally reused `checkDurationSeconds` (which is for SSL/TLS
  // check timing) and only labelled it by `result`, polluting the
  // cert-check metric with HTTP request latencies. (Copilot review:
  // index.ts:192, index.ts:195.)
  app.use("/api/*", async (c, next) => {
    const end = httpRequestDurationSeconds.startTimer();
    const dbEnd = dbQueryDurationSeconds.startTimer();
    try {
      await next();
    } finally {
      const status = c.res?.status ?? 0;
      end({
        result: status && status < 400 ? "success" : "failure",
        method: c.req.method,
      });
      dbEnd({ operation: "request" });
    }
  });

  return app;
}

export async function bootstrap() {
  getDb();
  runSqlMigrations();
  const app = createApp();
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const scheduler = startScheduler();
  logger.info(
    { port, cron: scheduler.expression, intervalMinutes: scheduler.intervalMinutes },
    `[api] CertPulse API listening on :${port}`
  );
  const server = serve({ fetch: app.fetch, port });

  // Graceful shutdown: stop accepting new connections, wait for in-flight
  // checks + alerts to finish, then close the DB and exit. Previous
  // implementation was fire-and-forget — process.exit(0) killed the event
  // loop while the scheduler lock (running=1) was still set in SQLite,
  // so the next boot bailed for 30 minutes believing a tick was still
  // alive. (v0.4.1 code-review CRITICAL.)
  const shutdown = async () => {
    logger.info("[api] shutting down");
    try {
      stopScheduler();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDb();
    } catch (err) {
      logger.error({ err }, "shutdown error");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Catch-all for anything that escaped every `try/catch`. Log and exit
  // cleanly so the orchestrator restarts us; without these the process
  // would just vanish with no trace.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException");
    void shutdown();
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandledRejection");
    void shutdown();
  });

  return { app, server };
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  bootstrap();
}
