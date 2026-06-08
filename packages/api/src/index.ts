import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb, closeDb, type DB } from "./db/index.js";
import { runSqlMigrations } from "./db/sqlmigrate.js";
import { createDomainsRouter } from "./routes/domains.js";
import { createChecksRouter } from "./routes/checks.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createChannelsRouter } from "./routes/channels.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { startScheduler, stopScheduler, getCheckIntervalMinutes } from "./services/scheduler.js";
import { recentAlerts } from "./services/alerter.js";

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

  // /health is public — the docker healthcheck and load balancers hit it
  // without credentials. It is registered BEFORE the auth middleware so
  // it can never be locked out.
  app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

  // Bearer-token auth on every /api/* route. Skips /health (registered above
  // before this middleware) and is bypassed only when AUTH_DISABLED is set
  // (dev mode — see auth.ts).
  app.use("/api/*", createAuthMiddleware(db));

  app.route("/api/domains", createDomainsRouter(db));
  app.route("/api/checks", createChecksRouter(db));
  app.route("/api/dashboard", createDashboardRouter(db));
  app.route("/api", createChannelsRouter(db));

  app.get("/api/alerts", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    return c.json({ alerts: recentAlerts(limit) });
  });

  app.get("/api/config", (c) =>
    c.json({
      checkIntervalMinutes: getCheckIntervalMinutes(),
      hasResend: Boolean(process.env.RESEND_API_KEY),
      alertEmailTo: process.env.ALERT_EMAIL_TO ?? null,
    })
  );

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((err, c) => {
    console.error("[api] error:", err);
    return c.json({ error: err.message ?? "Internal server error" }, 500);
  });

  return app;
}

export function bootstrap() {
  getDb();
  runSqlMigrations();
  const app = createApp();
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const scheduler = startScheduler();
  console.log(
    `[api] CertPulse API listening on :${port} (cron: ${scheduler.expression} = every ${scheduler.intervalMinutes}m)`
  );
  const server = serve({ fetch: app.fetch, port });

  const shutdown = () => {
    console.log("[api] shutting down...");
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
