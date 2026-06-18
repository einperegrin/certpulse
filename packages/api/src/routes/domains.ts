import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { type DB, getDb } from "../db/index.js";
import { domains, checks } from "../db/schema.js";
import { runCheckForDomainById } from "../services/checker-runner.js";
import { isPrivateAddress } from "../services/ssrf-guard.js";
import { recordAudit } from "../services/audit.js";
import { logger } from "../services/logger.js";
import { openApiRegistry } from "../openapi/registry.js";
import { domainWithCheckSchema, errorSchema } from "../openapi/schemas.js";

const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/,
    "Invalid hostname"
  );

const addDomainSchema = z.object({
  hostname: hostnameSchema,
  port: z.number().int().min(1).max(65535).optional().default(443),
});

type Env = {
  Variables: { db: DB; actor?: { id: number; label: string } };
};

export function createDomainsRouter(db: DB = getDb()): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  // OpenAPI: POST /api/domains — add a domain. The runtime handler
  // still does its own `safeParse` (because the response shape depends
  // on whether the first check succeeded), so the request schema here
  // is the source of truth for "what does a valid POST body look
  // like?".
  openApiRegistry.registerPath({
    method: "post",
    path: "/api/domains",
    summary: "Add a domain to monitor",
    tags: ["domains"],
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              hostname: z.string().min(1).max(253),
              port: z.number().int().min(1).max(65535).optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Domain created (and an initial check run)",
        content: {
          "application/json": {
            schema: z.object({
              domain: z.unknown(),
              firstCheck: z.unknown().nullable(),
            }),
          },
        },
      },
      400: {
        description: "Invalid hostname/port or blocked by SSRF/port guard",
        content: { "application/json": { schema: errorSchema } },
      },
      409: {
        description: "Domain already exists",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  });

  // OpenAPI: GET /api/domains — list all domains with their last check.
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/domains",
    summary: "List all monitored domains",
    tags: ["domains"],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "All domains, newest first, with their latest check",
        content: {
          "application/json": {
            schema: z.object({ domains: z.array(domainWithCheckSchema) }),
          },
        },
      },
    },
  });

  // OpenAPI: GET /api/domains/:id
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/domains/{id}",
    summary: "Get a single domain + its 10 most recent checks",
    tags: ["domains"],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.coerce.number().int() }),
    },
    responses: {
      200: {
        description: "Domain + recent checks",
        content: {
          "application/json": {
            schema: z.object({
              domain: z.unknown(),
              checks: z.array(z.unknown()),
            }),
          },
        },
      },
      404: {
        description: "Not found",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  });

  // OpenAPI: DELETE /api/domains/:id
  openApiRegistry.registerPath({
    method: "delete",
    path: "/api/domains/{id}",
    summary: "Delete a domain (and its channels, via FK cascade)",
    tags: ["domains"],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.coerce.number().int() }),
    },
    responses: {
      200: { description: "Deleted" },
      404: {
        description: "Not found",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  });

  // OpenAPI: POST /api/domains/:id/check
  openApiRegistry.registerPath({
    method: "post",
    path: "/api/domains/{id}/check",
    summary: "Force an immediate SSL check for one domain",
    tags: ["domains"],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.coerce.number().int() }),
    },
    responses: {
      200: {
        description: "Check ran",
        content: {
          "application/json": {
            schema: z.object({ ok: z.boolean(), outcome: z.unknown() }),
          },
        },
      },
      404: {
        description: "Domain not found",
        content: { "application/json": { schema: errorSchema } },
      },
      500: {
        description: "Check failed (network / TLS error)",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  });

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = addDomainSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    }
    const { hostname, port } = parsed.data;

    // SSRF guard: block private/loopback/link-local targets. Closes C-2.
    // Skip only when ALLOW_PRIVATE_HOSTS=1 (air-gapped deployments); the
    // operator must opt in explicitly. The same guard also runs in the
    // checker so a hostname that flips from public to private later is
    // still caught before we open a TCP connection.
    if (process.env.ALLOW_PRIVATE_HOSTS !== "1") {
      if (await isPrivateAddress(hostname)) {
        return c.json(
          {
            error: "Hostname resolves to a private/loopback/link-local address",
            hint:
              "CertPulse cannot monitor internal services by default. " +
              "Set ALLOW_PRIVATE_HOSTS=1 to override (not recommended).",
          },
          400
        );
      }
    }

    // Restrict port to standard TLS ports (443, 8443) unless explicitly
    // overridden. Closes part of H-1 — arbitrary port = easy pivot.
    if (
      process.env.ALLOW_NONSTANDARD_TLS_PORTS !== "1" &&
      port !== 443 &&
      port !== 8443
    ) {
      return c.json(
        {
          error: "Port must be 443 or 8443",
          hint: "Set ALLOW_NONSTANDARD_TLS_PORTS=1 to allow other ports.",
        },
        400
      );
    }

    const existing = db
      .select()
      .from(domains)
      .where(eq(domains.hostname, hostname))
      .limit(1)
      .all()[0];
    if (existing) {
      return c.json({ error: "Domain already exists", domain: existing }, 409);
    }
    const inserted = db
      .insert(domains)
      .values({ hostname, port })
      .returning()
      .all();
    const domain = inserted[0];
    if (!domain) {
      return c.json({ error: "Failed to create domain" }, 500);
    }
    // v0.3 audit log: who created this domain. actorId is the caller's
    // token label, populated by the auth middleware via c.get('actor').
    // Falls back to "unknown" if for some reason the actor is missing
    // (e.g. AUTH_DISABLED=1 in dev). (Copilot review: domains.ts:106.)
    recordAudit(db, {
      actorType: "api_token",
      actorId: c.get("actor")?.label ?? "unknown",
      action: "domain.create",
      resourceType: "domain",
      resourceId: String(domain.id),
      metadata: { hostname: domain.hostname, port: domain.port },
    });
    let firstCheck = null;
    try {
      firstCheck = await runCheckForDomainById(domain.id, db);
    } catch (err) {
      // Internal errors must not leak libuv/system strings (e.g.
      // `getaddrinfo ENOTFOUND <host>`) to the API client. The full
      // err is logged server-side with the request id.
      const requestId = crypto.randomUUID();
      logger.error({ err, requestId, domainId: domain.id }, "first check failed");
      firstCheck = { error: "check_failed", requestId };
    }
    return c.json({ domain, firstCheck }, 201);
  });

  app.get("/", (c) => {
    const rows = db
      .select({
        domain: domains,
        lastCheck: {
          id: checks.id,
          valid: checks.valid,
          daysRemaining: checks.daysRemaining,
          notAfter: checks.notAfter,
          issuer: checks.issuer,
          issuerOrg: checks.issuerOrg,
          error: checks.error,
          checkedAt: checks.checkedAt,
          domainExpiresAt: checks.domainExpiresAt,
          domainExpiresDaysRemaining: checks.domainExpiresDaysRemaining,
          domainRegistrar: checks.domainRegistrar,
          domainRegistrarError: checks.domainRegistrarError,
        },
      })
      .from(domains)
      .leftJoin(
        checks,
        and(
          eq(checks.domainId, domains.id),
          eq(
            checks.id,
            db
              .select({ id: checks.id })
              .from(checks)
              .where(eq(checks.domainId, domains.id))
              .orderBy(desc(checks.checkedAt))
              .limit(1)
          )
        )
      )
      .orderBy(desc(domains.createdAt))
      .all();
    return c.json({ domains: rows });
  });

  app.get("/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    const domain = db.select().from(domains).where(eq(domains.id, id)).limit(1).all()[0];
    if (!domain) return c.json({ error: "Not found" }, 404);
    const recent = db
      .select()
      .from(checks)
      .where(eq(checks.domainId, id))
      .orderBy(desc(checks.checkedAt))
      .limit(10)
      .all();
    return c.json({ domain, checks: recent });
  });

  app.delete("/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    const existing = db
      .select({ hostname: domains.hostname })
      .from(domains)
      .where(eq(domains.id, id))
      .limit(1)
      .all()[0];
    const result = db.delete(domains).where(eq(domains.id, id)).run();
    if (result.changes === 0) return c.json({ error: "Not found" }, 404);
    recordAudit(db, {
      actorType: "api_token",
      actorId: c.get("actor")?.label ?? "unknown",
      action: "domain.delete",
      resourceType: "domain",
      resourceId: String(id),
      metadata: { hostname: existing?.hostname },
    });
    return c.json({ ok: true });
  });

  app.post("/:id/check", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    const exists = db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.id, id))
      .limit(1)
      .all()[0];
    if (!exists) return c.json({ error: "Not found" }, 404);
    try {
      const outcome = await runCheckForDomainById(id, db);
      return c.json({ ok: true, outcome });
    } catch (err) {
      // Same sanitizer as POST / — never echo the libuv/TLS message
      // back to the API client. Full err is logged with the request id.
      const requestId = crypto.randomUUID();
      logger.error({ err, requestId, domainId: id }, "manual check failed");
      return c.json({ error: "check_failed", requestId }, 500);
    }
  });

  return app;
}

export const domainsRouter = createDomainsRouter();
