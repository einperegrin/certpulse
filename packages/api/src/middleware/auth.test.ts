import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { createAuthMiddleware } from "./auth.js";
import { generateToken, hashToken } from "../services/auth.js";
import * as schema from "../db/schema.js";
import { runSqlMigrations } from "../db/sqlmigrate.js";

type DB = BetterSQLite3Database<typeof schema>;

function makeDb(): { db: DB; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  runSqlMigrations(sqlite);
  return { db, sqlite };
}

describe("auth middleware", () => {
  beforeEach(() => {
    // The real auth path is what we want to exercise.
    // vitest.config sets AUTH_DISABLED=1 globally; clear it so middleware
    // actually runs the real check (vi.unstubAllEnvs in afterEach restores
    // the vitest.config value).
    vi.stubEnv("AUTH_DISABLED", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects request with no Authorization header", async () => {
    const { db } = makeDb();
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware(db));
    app.get("/api/test", (c) => c.json({ ok: true }));
    const res = await app.request("/api/test");
    expect(res.status).toBe(401);
  });

  it("rejects request with wrong token", async () => {
    const { db } = makeDb();
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware(db));
    app.get("/api/test", (c) => c.json({ ok: true }));
    const res = await app.request("/api/test", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects expired token", async () => {
    const { db } = makeDb();
    const token = generateToken();
    db.insert(schema.apiTokens)
      .values({
        tokenHash: hashToken(token),
        label: "expired",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      .run();
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware(db));
    app.get("/api/test", (c) => c.json({ ok: true }));
    const res = await app.request("/api/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/expired/i);
  });

  it("accepts request with valid token", async () => {
    const { db } = makeDb();
    const token = generateToken();
    db.insert(schema.apiTokens)
      .values({ tokenHash: hashToken(token), label: "test" })
      .run();
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware(db));
    app.get("/api/test", (c) => c.json({ ok: true }));
    const res = await app.request("/api/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("/health is not protected", async () => {
    const { db } = makeDb();
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware(db));
    app.get("/health", (c) => c.json({ ok: true }));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("AUTH_DISABLED=*** bypasses the check", async () => {
    vi.stubEnv("AUTH_DISABLED", "1");
    const { db } = makeDb();
    const app = new Hono();
    app.use("/api/*", createAuthMiddleware(db));
    app.get("/api/test", (c) => c.json({ ok: true }));
    const res = await app.request("/api/test");
    expect(res.status).toBe(200);
  });
});
