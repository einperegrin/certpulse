/**
 * In-memory rate limiter for /api/* (v0.3).
 *
 * Uses `rate-limiter-flexible`'s in-memory backend — single-instance
 * self-hosted, so we don't need a distributed store. The limiter is
 * keyed by client IP; behind the bundled nginx the `X-Forwarded-For`
 * header is the real source, so we read it first and fall back to
 * `c.req.header("x-real-ip")` / the literal string "unknown".
 *
 * Note: we deliberately do NOT read the raw socket remote address
 * here — Hono's request abstraction doesn't expose it, and in our
 * nginx-fronted deploy the socket peer is the proxy, not the real
 * client. (Copilot review: rate-limit.ts:10 — "the module comment
 * says the IP extraction falls back to ... the remote address" —
 * the comment is now accurate.)
 *
 * Defaults: 100 req/min per IP. Configurable via
 * `RATE_LIMIT_PER_MINUTE` env var. The /health/* and /metrics paths
 * are excluded — healthchecks and Prometheus scrapes can be much
 * more frequent than user-driven API traffic and would otherwise
 * trigger 429s.
 *
 * v0.4: also bumps two Prometheus counters for the Grafana dashboard:
 *   - `sslert_rate_limit_hits_total{path}` on every 429
 *   - `sslert_http_requests_total{method, path, status}` on every
 *     request that gets through (and on 429, with status="429" so the
 *     dashboard's "top error endpoints" panel catches rate-limited
 *     routes).
 */
import type { MiddlewareHandler } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { logger } from "../services/logger.js";
import {
  httpRequestsTotal,
  rateLimitHitsTotal,
} from "../lib/metrics.js";

const DEFAULT_RPM = 100;

/**
 * Singleton limiter. `rate-limiter-flexible` is designed to be
 * process-shared — one instance per process, never per-request.
 */
let limiter: RateLimiterMemory | null = null;

function getLimiter(): RateLimiterMemory {
  if (limiter) return limiter;
  const points = parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? `${DEFAULT_RPM}`, 10) || DEFAULT_RPM;
  limiter = new RateLimiterMemory({
    points,
    duration: 60,
  });
  return limiter;
}

/**
 * Reset the singleton — used by tests that want a fresh per-test
 * limiter. Not exported via the API.
 */
export function __resetRateLimiterForTests(): void {
  limiter = null;
}

/**
 * Extract the real client IP. Behind the bundled nginx the connection
 * remote address is the proxy, so X-Forwarded-For is the only useful
 * signal. The leftmost entry is the original client.
 */
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = c.req.header("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

/**
 * Use the route's matched path template (e.g. "/api/domains/:id") as
 * the `path` label, not the literal URL. This is what the Grafana
 * dashboard's "top 10 error endpoints" panel expects — it groups all
 * `/api/domains/42` and `/api/domains/7` calls into a single series
 * `/api/domains/:id` so cardinality stays bounded.
 *
 * Hono exposes the matched route at `c.req.routePath`. If a request
 * 404s before route matching (e.g. /api/unknown), `routePath` is
 * `undefined` — fall back to `c.req.path` and clip to the first two
 * URL segments to keep cardinality bounded anyway.
 */
function pathLabel(c: { req: { routePath?: string; path: string } }): string {
  const rp = c.req.routePath;
  if (rp && typeof rp === "string" && rp.length > 0) return rp;
  // Fallback for unmatched routes. Bucket to keep cardinality low.
  const segs = c.req.path.split("/").filter(Boolean);
  if (segs.length <= 2) return c.req.path;
  return "/" + segs.slice(0, 2).join("/") + "/*";
}

/**
 * Returns a Hono middleware that consumes one token from the per-IP
 * bucket and returns 429 with `Retry-After` when exhausted.
 *
 * The middleware is mounted on /api/* — /health and /metrics are
 * registered before this middleware in `index.ts`, so they are
 * automatically excluded.
 */
export function createRateLimitMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = process.hrtime.bigint();
    // AUTH_DISABLED dev mode is a special case; we still rate-limit
    // to keep dev behaviour close to prod.
    const ip = clientIp(c);
    const path = pathLabel(c);
    const method = c.req.method;
    let status = 200;
    try {
      await getLimiter().consume(ip, 1);
    } catch (rej) {
      // rate-limiter-flexible rejects with a `RateLimiterRes` object
      // containing `msBeforeNext`. Map to HTTP 429 + Retry-After.
      const msBeforeNext =
        typeof rej === "object" && rej !== null && "msBeforeNext" in rej
          ? Number((rej as { msBeforeNext: number }).msBeforeNext)
          : 60_000;
      const retryAfterSec = Math.max(1, Math.ceil(msBeforeNext / 1000));
      logger.warn({ ip, path: c.req.path, retryAfterSec }, "rate limit exceeded");
      c.header("Retry-After", String(retryAfterSec));
      rateLimitHitsTotal.inc({ path });
      status = 429;
      httpRequestsTotal.inc({ method, path, status: "429" });
      return c.json(
        { error: "Too many requests", retryAfter: retryAfterSec },
        429
      );
    }
    try {
      await next();
      status = c.res?.status ?? 200;
    } finally {
      // Record the request counter AFTER the handler so we see the
      // real status code (Hono sets it on `c.res` by the time the
      // `await next()` resolves). Falling back to 200 if not set.
      const statusStr = String(status);
      httpRequestsTotal.inc({ method, path, status: statusStr });
      // Cheap duration observation — re-use the existing histogram.
      // (httpRequestDurationSeconds is registered in lib/metrics.ts
      // with labels {result, method}; v0.4 keeps the existing label
      // set so we don't break scrapers.)
      const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
      // We import lazily to avoid a circular import in tests that
      // reset module state.
      const { httpRequestDurationSeconds } = await import("../lib/metrics.js");
      httpRequestDurationSeconds.observe(
        { result: status >= 500 ? "error" : status >= 400 ? "client_error" : "ok", method },
        elapsedSec
      );
    }
  };
}
