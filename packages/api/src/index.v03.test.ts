/**
 * End-to-end tests for the v0.3 observability + operations surface:
 *
 *  - GET /health/live and /health/ready (and the /health alias)
 *  - GET /metrics (Prometheus text format, gauge refresh, /health/* unaffected)
 *  - in-memory rate limiter (under limit passes, over limit returns 429 with Retry-After)
 *  - audit log writes from real CRUD endpoints
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApp } from "./index.js";
import { createInMemoryDb, type DB } from "./db/index.js";
import { runSqlMigrations } from "./db/sqlmigrate.js";
import { auditLog, domains as domainsTable } from "./db/schema.js";
import { sql } from "drizzle-orm";
import {
  __resetRateLimiterForTests,
  createRateLimitMiddleware,
} from "./middleware/rate-limit.js";

function makeApp(): { app: ReturnType<typeof createApp>; db: DB } {
  const { db, sqlite } = createInMemoryDb();
  runSqlMigrations(sqlite);
  const app = createApp({ db });
  return { app, db };
}

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.AUTH_DISABLED = "1";
  process.env.ALLOW_PRIVATE_HOSTS = "1";
  __resetRateLimiterForTests();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
});

describe("v0.3 health endpoints", () => {
  it("/health/live always returns 200 with no DB touch", async () => {
    const { app } = makeApp();
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; ts: string };
    expect(body.status).toBe("ok");
    expect(typeof body.ts).toBe("string");
  });

  it("/health is a backward-compat alias of /health/live", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("/health/ready reports ok + db=ok with checks breakdown", async () => {
    const { app } = makeApp();
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      timestamp: string;
      checks: { db: string; last_check_age_seconds: number | null };
    };
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("ok");
    expect(body.checks.last_check_age_seconds).toBeNull();
    expect(typeof body.timestamp).toBe("string");
  });

  it("/health/* endpoints are NOT rate-limited (verified indirectly)", async () => {
    // Hit /health/live 200 times — under any sane limit, this should
    // all succeed. If rate-limit middleware were mounted on /health/*,
    // later calls would return 429.
    const { app } = makeApp();
    for (let i = 0; i < 200; i++) {
      const r = await app.request("/health/live");
      if (r.status !== 200) {
        throw new Error(`call ${i} returned ${r.status}`);
      }
    }
  });
});

describe("v0.3 /metrics endpoint", () => {
  it("returns Prometheus text format and includes the default Node metrics", async () => {
    const { app } = makeApp();
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const text = await res.text();
    // prom-client default Node.js metrics include process_cpu_seconds_total.
    expect(text).toContain("process_cpu_user_seconds_total");
    // CertPulse custom metrics are registered.
    expect(text).toContain("certpulse_checks_total");
    expect(text).toContain("certpulse_db_query_duration_seconds");
  });

  it("refreshes domain / token gauges from the DB", async () => {
    const { app, db } = makeApp();
    db.insert(auditLog)
      .values({
        actorType: "system",
        actorId: "test",
        action: "noop",
        resourceType: "noop",
        resourceId: "0",
      })
      .run();
    // (We're just exercising the gauge refresh path; the actual count
    // of audit rows is irrelevant — we want to make sure the /metrics
    // scrape triggers the SELECT count(*) without crashing.)
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("certpulse_domains_total");
    expect(text).toContain("certpulse_tokens_total");
  });
});

describe("v0.3 rate limiter", () => {
  it("returns 429 with Retry-After after the per-IP budget is exhausted", async () => {
    // Force a tiny budget so the test is fast.
    process.env.RATE_LIMIT_PER_MINUTE = "3";
    __resetRateLimiterForTests();
    const app = new Hono();
    app.use("/api/*", createRateLimitMiddleware());
    app.get("/api/probe", (c) => c.json({ ok: true }));
    const call = () =>
      app.request("/api/probe", { headers: { "x-forwarded-for": "1.2.3.4" } });
    const r1 = await call();
    const r2 = await call();
    const r3 = await call();
    const r4 = await call();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r4.status).toBe(429);
    expect(r4.headers.get("retry-after")).toBeTruthy();
    const body = (await r4.json()) as { error: string; retryAfter: number };
    expect(body.error).toMatch(/too many/i);
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it("different IPs are tracked independently", async () => {
    process.env.RATE_LIMIT_PER_MINUTE = "1";
    __resetRateLimiterForTests();
    const app = new Hono();
    app.use("/api/*", createRateLimitMiddleware());
    app.get("/api/probe", (c) => c.json({ ok: true }));
    const a = await app.request("/api/probe", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    const b = await app.request("/api/probe", {
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe("v0.3 audit log integration with CRUD", () => {
  it("POST /api/domains creates an audit row", async () => {
    const { app, db } = makeApp();
    const res = await app.request("/api/domains", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "audit-create.example" }),
    });
    // First-check may fail because the hostname is unresolvable; the
    // 201 vs 200 is dictated by the create call, which is what we want
    // to assert on. Either way the domain row exists.
    expect([200, 201]).toContain(res.status);
    const rows = db
      .select()
      .from(auditLog)
      .where(sql`action = 'domain.create'`)
      .all();
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.metadata as { hostname: string };
    expect(meta.hostname).toBe("audit-create.example");
  });

  it("DELETE /api/domains/:id creates a domain.delete audit row", async () => {
    const { app, db } = makeApp();
    // Insert directly to avoid the first-check side-effect of POST
    // /api/domains (which writes into `checks` and blocks the
    // subsequent DELETE on a foreign-key constraint).
    const inserted = db
      .insert(domainsTable)
      .values({ hostname: "audit-delete.example" })
      .returning()
      .all()[0]!;
    const id = inserted.id;
    const del = await app.request(`/api/domains/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const rows = db
      .select()
      .from(auditLog)
      .where(sql`action = 'domain.delete'`)
      .all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.resourceId === String(id))).toBe(true);
  });

  it("POST /api/domains/:id/channels creates a channel.create audit row", async () => {
    const { app, db } = makeApp();
    const created = await app.request("/api/domains", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "audit-channel.example" }),
    });
    const createdBody = (await created.json()) as { domain: { id: number } };
    const domainId = createdBody.domain.id;
    const ch = await app.request(`/api/domains/${domainId}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "webhook",
        config: { url: "https://example.com/hook" },
      }),
    });
    // webhook URL guard accepts example.com.
    expect([200, 201]).toContain(ch.status);
    const rows = db
      .select()
      .from(auditLog)
      .where(sql`action = 'channel.create'`)
      .all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/audit-log returns the audit rows (newest first)", async () => {
    const { app } = makeApp();
    // Create one to log.
    await app.request("/api/domains", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "audit-list.example" }),
    });
    const res = await app.request("/api/audit-log");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ action: string; timestamp: string }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
    // Newest-first ordering.
    for (let i = 1; i < body.rows.length; i++) {
      const prev = new Date(body.rows[i - 1]!.timestamp).getTime();
      const cur = new Date(body.rows[i]!.timestamp).getTime();
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });
});
