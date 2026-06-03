import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { type DB, getDb } from "../db/index.js";
import { alertChannels, domains } from "../db/schema.js";

const channelNameSchema = z.enum(["email", "webhook", "telegram", "slack", "ntfy"]);

// Config validation per channel. Empty / partial configs are accepted —
// the sender decides what is "missing required field" at send time.
const channelConfigSchema = z
  .object({
    url: z.string().url().optional(),
    to: z.string().email().optional(),
    from: z.string().optional(),
    botToken: z.string().optional(),
    chatId: z.union([z.string(), z.number()]).optional(),
    topic: z.string().optional(),
    server: z.string().optional(),
  })
  .strict()
  .partial();

const createSchema = z.object({
  channel: channelNameSchema,
  enabled: z.boolean().optional().default(true),
  config: channelConfigSchema.optional().default({}),
});

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  config: channelConfigSchema.optional(),
});

type Env = {
  Variables: { db: DB };
};

function ensureDomainExists(db: DB, domainId: number): boolean {
  const row = db
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.id, domainId))
    .limit(1)
    .all()[0];
  return Boolean(row);
}

export function createChannelsRouter(db: DB = getDb()): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  // List all channels for a domain (includes the synthetic default-email
  // fallback when ALERT_EMAIL_TO is set globally).
  app.get("/domains/:domainId/channels", (c) => {
    const domainId = parseInt(c.req.param("domainId"), 10);
    if (Number.isNaN(domainId)) return c.json({ error: "Invalid domainId" }, 400);
    if (!ensureDomainExists(db, domainId)) return c.json({ error: "Domain not found" }, 404);

    const rows = db
      .select()
      .from(alertChannels)
      .where(eq(alertChannels.domainId, domainId))
      .all();

    // Add a synthetic default-email entry if the user has ALERT_EMAIL_TO set
    // and no explicit email row exists for this domain.
    const explicitEmail = rows.find((r) => r.channel === "email");
    const out = rows.map((r) => ({
      id: r.id,
      domainId: r.domainId,
      channel: r.channel,
      enabled: r.enabled,
      config: parseConfig(r.config),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    if (!explicitEmail && process.env.ALERT_EMAIL_TO) {
      out.push({
        id: 0,
        domainId,
        channel: "email",
        enabled: true,
        config: {
          to: process.env.ALERT_EMAIL_TO,
          from: process.env.ALERT_EMAIL_FROM ?? "certpulse@localhost",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return c.json({ channels: out });
  });

  // Add (or upsert) a channel for a domain.
  app.post("/domains/:domainId/channels", async (c) => {
    const domainId = parseInt(c.req.param("domainId"), 10);
    if (Number.isNaN(domainId)) return c.json({ error: "Invalid domainId" }, 400);
    if (!ensureDomainExists(db, domainId)) return c.json({ error: "Domain not found" }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    }

    const configJson = JSON.stringify(parsed.data.config);

    // Upsert by (domain_id, channel). For email, this overrides the
    // synthetic default and is the only way to set per-domain email
    // recipients explicitly.
    const existing = db
      .select({ id: alertChannels.id })
      .from(alertChannels)
      .where(
        and(eq(alertChannels.domainId, domainId), eq(alertChannels.channel, parsed.data.channel))
      )
      .limit(1)
      .all()[0];

    if (existing) {
      const updated = db
        .update(alertChannels)
        .set({
          enabled: parsed.data.enabled,
          config: configJson,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(alertChannels.id, existing.id))
        .returning()
        .all()[0];
      return c.json({ channel: rowToJson(updated) });
    }

    const now = new Date().toISOString();
    // Drizzle 0.36 infers the value type from the required-without-default
    // columns only; the boolean default and timestamp defaults are fine
    // at runtime, so we widen the call site to the full Insert type.
    const values = {
      domainId,
      channel: parsed.data.channel,
      enabled: parsed.data.enabled,
      config: configJson,
      createdAt: now,
      updatedAt: now,
    } as typeof alertChannels.$inferInsert;
    const inserted = db.insert(alertChannels).values(values).returning().all()[0];
    return c.json({ channel: rowToJson(inserted) }, 201);
  });

  // Update an existing channel.
  app.patch("/domains/:domainId/channels/:id", async (c) => {
    const domainId = parseInt(c.req.param("domainId"), 10);
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(domainId) || Number.isNaN(id)) {
      return c.json({ error: "Invalid id" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    }
    const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (parsed.data.enabled !== undefined) update.enabled = parsed.data.enabled;
    if (parsed.data.config !== undefined) update.config = JSON.stringify(parsed.data.config);

    const result = db
      .update(alertChannels)
      .set(update)
      .where(and(eq(alertChannels.id, id), eq(alertChannels.domainId, domainId)))
      .returning()
      .all()[0];
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json({ channel: rowToJson(result) });
  });

  // Delete a channel.
  app.delete("/domains/:domainId/channels/:id", (c) => {
    const domainId = parseInt(c.req.param("domainId"), 10);
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(domainId) || Number.isNaN(id)) {
      return c.json({ error: "Invalid id" }, 400);
    }
    const result = db
      .delete(alertChannels)
      .where(and(eq(alertChannels.id, id), eq(alertChannels.domainId, domainId)))
      .run();
    if (result.changes === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rowToJson(r: typeof alertChannels.$inferSelect) {
  return {
    id: r.id,
    domainId: r.domainId,
    channel: r.channel,
    enabled: r.enabled,
    config: parseConfig(r.config),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const channelsRouter = createChannelsRouter();
