/**
 * Tests for v0.4 OpenAPI surface:
 *  - GET /api/openapi.json returns a valid OpenAPI 3.1 document
 *  - GET /api/docs returns Swagger UI HTML
 *  - Both endpoints work WITHOUT a Bearer token (publicly browsable)
 *  - The spec contains all expected paths
 *  - The spec's components.securitySchemes.bearerAuth is defined
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index.js";
import { createInMemoryDb, type DB } from "./db/index.js";
import { runSqlMigrations } from "./db/sqlmigrate.js";

function makeApp(): { app: ReturnType<typeof createApp>; db: DB } {
  const { db, sqlite } = createInMemoryDb();
  runSqlMigrations(sqlite);
  const app = createApp({ db });
  return { app, db };
}

const originalEnv = { ...process.env };
beforeEach(() => {
  // Even with AUTH_DISABLED=1, the two doc endpoints should be
  // reachable. We test them BOTH with and without auth state.
  process.env.AUTH_DISABLED = "1";
  process.env.ALLOW_PRIVATE_HOSTS = "1";
});
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
});

describe("v0.4 OpenAPI spec + Swagger UI", () => {
  it("GET /api/openapi.json returns a valid OpenAPI 3.x document", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe("SSLert API");
    expect(spec.info.version).toBeDefined();
    expect(spec.paths).toBeDefined();
  });

  it("GET /api/docs returns HTML containing 'Swagger UI'", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/docs");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Swagger UI/i);
  });

  it("Both /api/openapi.json and /api/docs are reachable WITHOUT a Bearer token", async () => {
    // Disable auth to be extra sure these endpoints are exempt.
    process.env.AUTH_DISABLED = "1";
    delete process.env.SSLERT_API_TOKEN;

    const { app } = makeApp();
    const specRes = await app.request("/api/openapi.json");
    expect(specRes.status).toBe(200);
    const docsRes = await app.request("/api/docs");
    expect(docsRes.status).toBe(200);
  });

  it("Both endpoints are reachable even when auth would be required for /api/*", async () => {
    // In this mode the app will require Bearer for /api/domains etc,
    // but the spec + docs endpoints must remain publicly browsable.
    delete process.env.AUTH_DISABLED;
    const { app } = makeApp();

    const specRes = await app.request("/api/openapi.json");
    expect(specRes.status).toBe(200);
    const docsRes = await app.request("/api/docs");
    expect(docsRes.status).toBe(200);

    // And the protected route still demands auth.
    const protectedRes = await app.request("/api/domains");
    expect(protectedRes.status).toBe(401);
  });

  it("Spec contains all expected paths", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/openapi.json");
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    const expectedPaths = [
      "/api/domains",
      "/api/domains/{id}",
      "/api/domains/{id}/check",
      "/api/domains/{domainId}/channels",
      "/api/domains/{domainId}/channels/{id}",
      "/api/checks",
      "/api/audit-log",
      "/api/dashboard",
      "/api/alerts",
      "/api/config",
      "/api/openapi.json",
      "/api/docs",
      "/health/live",
      "/health/ready",
      "/metrics",
    ];
    for (const p of expectedPaths) {
      expect(spec.paths[p]).toBeDefined();
    }
  });

  it("Spec defines components.securitySchemes.bearerAuth", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/openapi.json");
    const spec = (await res.json()) as {
      components?: { securitySchemes?: Record<string, { type: string; scheme: string }> };
    };
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(spec.components!.securitySchemes!.bearerAuth.type).toBe("http");
    expect(spec.components!.securitySchemes!.bearerAuth.scheme).toBe("bearer");
  });
});
