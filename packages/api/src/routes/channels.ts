import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { type DB, getDb } from "../db/index.js";
import { alertChannels, domains } from "../db/schema.js";
import { validateWebhookUrl } from "../services/url-guard.js";
import { recordAudit } from "../services/audit.js";
import { openApiRegistry } from "../openapi/registry.js";
import { channelSchema, errorSchema } from "../openapi/schemas.js";
import { toIsoString } from "../lib/datetime.js";

const channelNameSchema = z.enum(["email", "webhook", "telegram", "slack", "ntfy"]);

// Config validation per channel. Empty / partial configs are accepted —
// the sender decides what is "missing required field" at send time.
//
// `secret` is an optional HMAC-SHA256 signing secret for the generic
// webhook channel. When set, the sender computes
// `HMAC-SHA256(secret, rawBody)` and adds the
// `X-SSLert-Signature: sha256=<hex>` + `X-SSLert-Timestamp`
// headers so the receiver can verify the alert came from this
// SSLert instance. Min length 16, max 256.
const channelConfigSchema = z
  .object({
    url: z.string().url().optional(),
    to: z.string().email().optional(),
    from: z.string().optional(),
    botToken: z.string().optional(),
    chatId: z.union([z.string(), z.number()]).optional(),
    topic: z.string().optional(),
    server: z.string().optional(),
    secret: z.string().min(16).max(256).optional(),
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

/**
 * Validate URL-bearing fields in a channel config. Runs the same SSRF +
 * scheme guard the senders use, so a misconfigured channel is rejected
 * at save time (with 400) instead of at alert time (with a confusing
 * `Webhook error: invalid URL` from the sender). Closes H-1.
 */
async function validateChannelConfig(
  channel: "email" | "webhook" | "telegram" | "slack" | "ntfy",
  config: Record<string, unknown>
): Promise<string | null> {
  if (channel === "webhook" || channel === "slack") {
    const url = config.url;
    if (typeof url !== "string" || !url) {
      return "url is required for webhook/slack channels";
    }
    const v = await validateWebhookUrl(url);
    return v.ok ? null : v.error ?? "invalid url";
  }
  if (channel === "ntfy") {
    let url: unknown = config.url;
    if (!url && typeof config.topic === "string" && config.topic) {
      const server =
        typeof config.server === "string" && config.server
          ? config.server.replace(/\/$/, "")
          : "https://ntfy.sh";
      url = `${server}/${config.topic}`;
    }
    if (typeof url !== "string" || !url) {
      return "url or topic is required for ntfy channel";
    }
    const v = await validateWebhookUrl(url);
    return v.ok ? null : v.error ?? "invalid url";
  }
  // email / telegram — no URL to validate (telegram bot token is opaque
  // and the API host is hardcoded).
  return null;
}

type Env = {
  Variables: { db: DB; actor?: { id: number; label: string } };
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

  // OpenAPI: GET /api/domains/:domainId/channels
  openApiRegistry.registerPath({
    method: "get",
    path: "/api/domains/{domainId}/channels",
    summary: "List alert channels for a domain",
    tags: ["channels"],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ domainId: z.coerce.number().int() }),
    },
    responses: {
      200: {
        description: "Channels (plus synthetic default-email if ALERT_EMAIL_TO is set)",
        content: {
          "application/json": {
            schema: z.object({ channels: z.array(channelSchema) }),
          },
        },
      },
      404: {
        description: "Domain not found",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  });

  // OpenAPI: POST /api/domains/:domainId/channels
  openApiRegistry.registerPath({
    method: "post",
    path: "/api/domains/{domainId}/channels",
    summary: "Add (or upsert) a channel for a domain",
    tags: ["channels"],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ domainId: z.coerce.number().int() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              channel: z.enum(["email", "webhook", "telegram", "slack", "ntfy"]),
              enabled: z.boolean().optional(),
              config: z
                .object({
                  url: z.string().url().optional(),
                  to: z.string().email().optional(),
                  from: z.string().optional(),
                  botToken: z.string().optional(),
                  chatId: z.union([z.string(), z.number()]).optional(),
                  topic: z.string().optional(),
                  server: z.string().optional(),
                  secret: z.string().min(16).max(256).optional(),
                })
                .optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Channel created",
        content: {
          "application/json": { schema: z.object({ channel: channelSchema }) },
        },
      },
      200: {
        description: "Channel updated (upsert)",
        content: {
          "application/json": { schema: z.object({ channel: channelSchema }) },
        },
      },
      400: {
        description: "Invalid body or URL rejected by SSRF guard",
        content: { "application/json": { schema: errorSchema } },
      },
      404: {
        description: "Domain not found",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  });

  // OpenAPI: PATCH /api/domains/:domainId/channels/:id
  openApiRegistry.registerPath({
    method: "patch",
    path: "/api/domains/{domainId}/channels/{id}",
    summary: "Update an existing channel",
    tags: ["channels"],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        domainId: z.coerce.number().int(),
        id: z.coerce.number().int(),
      }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              enabled: z.boolean().optional(),
              config: z
                .object({
                  url: z.string().url().optional(),
                  to: z.string().email().optional(),
                  from: z.string().optional(),
                  botToken: z.string().optional(),
                  chatId: z.union([z.string(), z.number()]).optional(),
                  topic: z.string().optional(),
                  server: z.string().optional(),
                  secret: z.string().min(16).max(256).optional(),
                })
                .optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Channel updated",
        content: {
          "application/json": { schema: z.object({ channel: channelSchema }) },
        },
      },
      400: {
        description: "Invalid body or URL rejected by SSRF guard",
        content: { "application/json": { schema: errorSchema } },
      },
      404: {
        description: "Channel not found",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  });

  // OpenAPI: DELETE /api/domains/:domainId/channels/:id
  openApiRegistry.registerPath({
    method: "delete",
    path: "/api/domains/{domainId}/channels/{id}",
    summary: "Delete a channel",
    tags: ["channels"],
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        domainId: z.coerce.number().int(),
        id: z.coerce.number().int(),
      }),
    },
    responses: {
      200: { description: "Deleted" },
      404: {
        description: "Channel not found",
        content: { "application/json": { schema: errorSchema } },
      },
    },
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
    // Bug #1 fix: route every row through `rowToJson` so the
    // `createdAt` / `updatedAt` are ISO 8601 with `Z`. Previously
    // line 288 returned the raw SQLite string, which a UTC+2 browser
    // would parse as local time and render "Created 2h ago" the
    // moment the row was inserted.
    const out = rows.map(rowToJson);
    if (!explicitEmail && process.env.ALERT_EMAIL_TO) {
      out.push({
        id: 0,
        domainId,
        channel: "email",
        enabled: true,
        config: {
          to: process.env.ALERT_EMAIL_TO,
          from: process.env.ALERT_EMAIL_FROM ?? "sslert@localhost",
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

    // H-1: validate URL-bearing channel config at write time.
    const urlError = await validateChannelConfig(
      parsed.data.channel,
      parsed.data.config
    );
    if (urlError) {
      return c.json({ error: urlError }, 400);
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
      recordAudit(db, {
        actorType: "api_token",
        actorId: c.get("actor")?.label ?? "unknown",
        action: "channel.update",
        resourceType: "channel",
        resourceId: String(existing.id),
        metadata: {
          domainId,
          channel: parsed.data.channel,
          enabled: parsed.data.enabled,
        },
      });
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
    recordAudit(db, {
      actorType: "api_token",
      actorId: c.get("actor")?.label ?? "unknown",
      action: "channel.create",
      resourceType: "channel",
      resourceId: String(inserted.id),
      metadata: {
        domainId,
        channel: parsed.data.channel,
        enabled: parsed.data.enabled,
      },
    });
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

    // H-1: if the patch updates the config, re-validate URL-bearing fields.
    // We need the channel name to know which fields to check, so we read
    // the existing row.
    if (parsed.data.config !== undefined) {
      const existing = db
        .select({ channel: alertChannels.channel })
        .from(alertChannels)
        .where(and(eq(alertChannels.id, id), eq(alertChannels.domainId, domainId)))
        .limit(1)
        .all()[0];
      if (!existing) {
        return c.json({ error: "Not found" }, 404);
      }
      const urlError = await validateChannelConfig(
        existing.channel as "email" | "webhook" | "telegram" | "slack" | "ntfy",
        parsed.data.config
      );
      if (urlError) {
        return c.json({ error: urlError }, 400);
      }
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
    recordAudit(db, {
      actorType: "api_token",
      actorId: c.get("actor")?.label ?? "unknown",
      action: "channel.update",
      resourceType: "channel",
      resourceId: String(id),
      metadata: {
        domainId,
        enabled: parsed.data.enabled,
        configChanged: parsed.data.config !== undefined,
      },
    });
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
    recordAudit(db, {
      actorType: "api_token",
      actorId: c.get("actor")?.label ?? "unknown",
      action: "channel.delete",
      resourceType: "channel",
      resourceId: String(id),
      metadata: { domainId },
    });
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
    // v0.5 timezone fix: the row stores `created_at` / `updated_at`
    // as `YYYY-MM-DD HH:MM:SS` UTC. Rewrite on the way out so the
    // frontend doesn't show "Created 2h ago" the moment the row is
    // inserted (Roman's bug, 2026-06-23).
    createdAt: toIsoString(r.createdAt),
    updatedAt: toIsoString(r.updatedAt),
  };
}

export const channelsRouter = createChannelsRouter();
