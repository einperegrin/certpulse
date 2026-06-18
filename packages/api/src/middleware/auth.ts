/**
 * Bearer-token auth middleware.
 *
 * Skips `/health` (used by the docker healthcheck and never carries data)
 * and is bypassed entirely when `AUTH_DISABLED` is set — for local dev
 * only. The escape hatch is documented; production deployments must NOT
 * set it.
 *
 * On a valid token, the caller's token row is exposed to downstream
 * handlers via `c.get('actor') = { id, label }` so audit writes can
 * attribute CRUD operations to the right token. `last_used_at` is
 * updated best-effort so operators can audit stale credentials. A
 * failure to update never blocks the request — auditability is
 * nice-to-have, the user request is the primary job.
 */
import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../db/index.js";
import { apiTokens } from "../db/schema.js";
import { hashToken } from "../services/auth.js";

/**
 * Shape of the actor record stashed on the request by the auth
 * middleware. Handlers read it back via `c.get('actor')` and pass
 * the label into `recordAudit(..., { actorId: actor.label })`.
 */
export interface RequestActor {
  id: number;
  label: string;
}

export type AuthEnv = {
  Variables: {
    actor?: RequestActor;
  };
};

export function createAuthMiddleware(db: DB): MiddlewareHandler<AuthEnv> {
  return async (c: Context<AuthEnv>, next) => {
    // Dev escape hatch — NEVER set in production. Strictly compared so
    // `AUTH_DISABLED=false` (or any other non-"1" value) leaves auth ON.
    // The composer/scheduler refuse to boot in production with this set.
    if (process.env.AUTH_DISABLED === "1") {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "AUTH_DISABLED=1 is forbidden in production. Remove the env var."
        );
      }
      return next();
    }

    // /health is used by the docker healthcheck and must stay public.
    if (c.req.path === "/health") return next();

    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) return c.json({ error: "Empty bearer token" }, 401);

    const candidates = db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hashToken(token)))
      .limit(1)
      .all();

    if (candidates.length === 0) {
      return c.json({ error: "Invalid token" }, 401);
    }

    const found = candidates[0];

    // Check expiry
    if (found.expiresAt && new Date(found.expiresAt) < new Date()) {
      return c.json({ error: "Token expired" }, 401);
    }

    // Expose the actor to downstream handlers so audit writes can
    // attribute the action. (Copilot review: domains.ts:106 / 189,
    // channels.ts:193 / 221 / 288 / 314 — audit rows were written
    // with actorId: null instead of the caller's token label.)
    c.set("actor", { id: found.id, label: found.label });

    // Update last_used_at (best-effort, don't fail the request)
    try {
      db.update(apiTokens)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(apiTokens.id, found.id))
        .run();
    } catch {
      // ignore — last-used bookkeeping should never block a request
    }

    return next();
  };
}
