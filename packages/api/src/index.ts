import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getDb, closeDb } from "./db/index.js";
import { runSqlMigrations } from "./db/sqlmigrate.js";
import { domainsRouter } from "./routes/domains.js";
import { checksRouter } from "./routes/checks.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { startScheduler, stopScheduler, getCheckIntervalMinutes } from "./services/scheduler.js";
import { recentAlerts } from "./services/alerter.js";

export function createApp() {
  const app = new Hono();

  app.use("*", cors({ origin: "*" }));

  app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

  app.route("/api/domains", domainsRouter);
  app.route("/api/checks", checksRouter);
  app.route("/api/dashboard", dashboardRouter);

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
