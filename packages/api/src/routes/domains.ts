import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { domains, checks } from "../db/schema.js";
import { runCheckForDomainById } from "../services/checker-runner.js";

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

export const domainsRouter = new Hono();

domainsRouter.post("/", async (c) => {
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
  const db = getDb();
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
  let firstCheck = null;
  try {
    firstCheck = await runCheckForDomainById(domain.id);
  } catch (err) {
    firstCheck = { error: err instanceof Error ? err.message : String(err) };
  }
  return c.json({ domain, firstCheck }, 201);
});

domainsRouter.get("/", (c) => {
  const db = getDb();
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

domainsRouter.get("/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const db = getDb();
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

domainsRouter.delete("/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const db = getDb();
  const result = db.delete(domains).where(eq(domains.id, id)).run();
  if (result.changes === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

domainsRouter.post("/:id/check", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const db = getDb();
  const exists = db
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.id, id))
    .limit(1)
    .all()[0];
  if (!exists) return c.json({ error: "Not found" }, 404);
  try {
    const outcome = await runCheckForDomainById(id);
    return c.json({ ok: true, outcome });
  } catch (err) {
    return c.json(
      { error: "Check failed", message: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});
