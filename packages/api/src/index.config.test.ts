/**
 * End-to-end tests for the public-facing config endpoint (M-3).
 *
 * The endpoint must NOT leak the `ALERT_EMAIL_TO` env var — that's PII
 * in shared environments. It should return only:
 *   - checkIntervalMinutes (numeric, capped at 24h)
 *   - hasResend (boolean — true iff RESEND_API_KEY is set)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createAuthMiddleware } from "./middleware/auth.js";
import { getCheckIntervalMinutes } from "./services/scheduler.js";
import { logger } from "./services/logger.js";

// Silence the boot log so test output stays clean.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setLogLevel = (lvl: string) => ((logger as any).level = lvl);

function buildApp() {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.use("/api/*", createAuthMiddleware({} as never));
  app.get("/api/config", (c) =>
    c.json({
      checkIntervalMinutes: getCheckIntervalMinutes(),
      hasResend: Boolean(process.env.RESEND_API_KEY),
    })
  );
  return app;
}

describe("GET /api/config (M-3)", () => {
  let savedAuth: string | undefined;
  let savedEmail: string | undefined;
  let savedResend: string | undefined;
  let savedInterval: string | undefined;
  let savedLogLevel: string | undefined;

  beforeEach(() => {
    savedAuth = process.env.AUTH_DISABLED;
    savedEmail = process.env.ALERT_EMAIL_TO;
    savedResend = process.env.RESEND_API_KEY;
    savedInterval = process.env.CHECK_INTERVAL;
    savedLogLevel = process.env.LOG_LEVEL;
    setLogLevel("silent");
    // Short-circuit auth — the test only exercises /api/config.
    process.env.AUTH_DISABLED = "1";
  });
  afterEach(() => {
    if (savedAuth === undefined) delete process.env.AUTH_DISABLED;
    else process.env.AUTH_DISABLED = savedAuth;
    if (savedEmail === undefined) delete process.env.ALERT_EMAIL_TO;
    else process.env.ALERT_EMAIL_TO = savedEmail;
    if (savedResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedResend;
    if (savedInterval === undefined) delete process.env.CHECK_INTERVAL;
    else process.env.CHECK_INTERVAL = savedInterval;
    setLogLevel(savedLogLevel ?? "info");
  });

  it("never exposes ALERT_EMAIL_TO in the response", async () => {
    process.env.ALERT_EMAIL_TO = "alerts@example.com";
    const res = await buildApp().request("/api/config");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.alertEmailTo).toBeUndefined();
    expect(body.alert_email_to).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("alerts@example.com");
  });

  it("returns hasResend=false when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await buildApp().request("/api/config");
    const body = (await res.json()) as { hasResend: boolean };
    expect(body.hasResend).toBe(false);
  });

  it("returns hasResend=true when RESEND_API_KEY is set", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const res = await buildApp().request("/api/config");
    const body = (await res.json()) as { hasResend: boolean };
    expect(body.hasResend).toBe(true);
  });

  it("returns checkIntervalMinutes from env (capped at 24h)", async () => {
    process.env.CHECK_INTERVAL = "120";
    const res = await buildApp().request("/api/config");
    const body = (await res.json()) as { checkIntervalMinutes: number };
    expect(body.checkIntervalMinutes).toBe(120);
  });
});
