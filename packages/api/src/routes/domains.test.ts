import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb, type DB } from "../db/index.js";
import { runSqlMigrations } from "../db/sqlmigrate.js";
import { checks, domains } from "../db/schema.js";
import Database from "better-sqlite3";
import { createApp } from "../index.js";

function makeDb(): { db: DB; sqlite: Database.Database } {
  const { db, sqlite } = createInMemoryDb();
  runSqlMigrations(sqlite);
  return { db, sqlite };
}

describe("domain CRUD HTTP", () => {
  let app: ReturnType<typeof createApp>;
  let db: DB;
  let sqlite: Database.Database;

  beforeEach(() => {
    const m = makeDb();
    db = m.db;
    sqlite = m.sqlite;
    app = createApp({ db });
  });

  it("creates a domain via POST /api/domains (but skips the live check)", async () => {
    // We patch the create flow: post and accept that first check will fail
    // (unreachable host in this environment).
    const res = await app.request("/api/domains", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "this-host-does-not-exist-12345.invalid" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      domain: { id: number; hostname: string };
      firstCheck: { error?: string; daysRemaining?: number | null };
    };
    expect(body.domain.hostname).toBe("this-host-does-not-exist-12345.invalid");
    expect(body.firstCheck).toBeTruthy();
    expect(body.firstCheck.error).toBeTruthy();
  });

  it("returns 409 when adding a duplicate domain", async () => {
    db.insert(domains).values({ hostname: "dup.example.com", port: 443 }).run();
    const res = await app.request("/api/domains", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "dup.example.com" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 400 on invalid hostname", async () => {
    const res = await app.request("/api/domains", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "not a hostname" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/domains returns the list", async () => {
    db.insert(domains).values({ hostname: "a.example.com", port: 443 }).run();
    db.insert(domains).values({ hostname: "b.example.com", port: 443 }).run();
    const res = await app.request("/api/domains");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: unknown[] };
    expect(body.domains.length).toBe(2);
  });

  it("GET /api/domains/:id returns detail with last checks", async () => {
    const inserted = db
      .insert(domains)
      .values({ hostname: "x.example.com", port: 443 })
      .returning()
      .all()[0]!;
    db.insert(checks)
      .values({
        domainId: inserted.id,
        valid: true,
        daysRemaining: 45,
        notAfter: new Date(Date.now() + 45 * 86400_000).toISOString(),
      })
      .run();
    const res = await app.request(`/api/domains/${inserted.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: { hostname: string }; checks: { daysRemaining: number }[] };
    expect(body.domain.hostname).toBe("x.example.com");
    expect(body.checks.length).toBe(1);
    expect(body.checks[0]!.daysRemaining).toBe(45);
  });

  it("DELETE /api/domains/:id removes the domain", async () => {
    const inserted = db
      .insert(domains)
      .values({ hostname: "delete.example.com", port: 443 })
      .returning()
      .all()[0]!;
    const res = await app.request(`/api/domains/${inserted.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const after = db.select().from(domains).all();
    expect(after.length).toBe(0);
  });

  it("GET /api/domains/:id returns 404 for missing domain", async () => {
    const res = await app.request("/api/domains/99999");
    expect(res.status).toBe(404);
  });
});

describe("dashboard HTTP", () => {
  let app: ReturnType<typeof createApp>;
  let db: DB;
  let sqlite: Database.Database;

  beforeEach(() => {
    const m = makeDb();
    db = m.db;
    sqlite = m.sqlite;
    app = createApp({ db });
  });

  it("returns summary with healthy/expiring/expired counts", async () => {
    const a = db
      .insert(domains)
      .values({ hostname: "healthy.example.com", port: 443 })
      .returning()
      .all()[0]!;
    const b = db
      .insert(domains)
      .values({ hostname: "soon.example.com", port: 443 })
      .returning()
      .all()[0]!;
    const c = db
      .insert(domains)
      .values({ hostname: "expired.example.com", port: 443 })
      .returning()
      .all()[0]!;
    db.insert(checks)
      .values({ domainId: a.id, valid: true, daysRemaining: 60, notAfter: new Date(Date.now() + 60 * 86400_000).toISOString() })
      .run();
    db.insert(checks)
      .values({ domainId: b.id, valid: true, daysRemaining: 12, notAfter: new Date(Date.now() + 12 * 86400_000).toISOString() })
      .run();
    db.insert(checks)
      .values({ domainId: c.id, valid: false, daysRemaining: -2, notAfter: new Date(Date.now() - 2 * 86400_000).toISOString() })
      .run();

    const res = await app.request("/api/dashboard");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      healthy: number;
      expiringSoon: number;
      expired: number;
    };
    expect(body.total).toBe(3);
    expect(body.healthy).toBe(1);
    expect(body.expiringSoon).toBe(1);
    expect(body.expired).toBe(1);
  });
});
