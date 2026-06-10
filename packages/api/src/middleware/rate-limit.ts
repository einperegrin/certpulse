/**
 * In-memory rate limiter for /api/* (v0.3).
 *
 * Uses `rate-limiter-flexible`'s in-memory backend — single-instance
 * self-hosted, so we don't need a distributed store. The limiter is
 * keyed by client IP; behind the bundled nginx the `X-Forwarded-For`
 * header is the real source, so we read it first and fall back to
 * `c.req.header("x-real-ip")` / the literal string "unknown" (we do
 * not read the raw socket address, which is the proxy in our deploy).
 *
 * Defaults: 100 req/min per IP. Configurable via
 * `RATE_LIMIT_PER_MINUTE` env var. The /health/* and /metrics paths
 * are excluded — healthchecks and Prometheus scrapes can be much
 * more frequent than user-driven API traffic and would otherwise
 * trigger 429s.
 */
import type { MiddlewareHandler } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { logger } from "../services/logger.js";

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
 * Returns a Hono middleware that consumes one token from the per-IP
 * bucket and returns 429 with `Retry-After` when exhausted.
 *
 * The middleware is mounted on /api/* — /health and /metrics are
 * registered before this middleware in `index.ts`, so they are
 * automatically excluded.
 */
export function createRateLimitMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // AUTH_DISABLED dev mode is a special case; we still rate-limit
    // to keep dev behaviour close to prod.
    const ip = clientIp(c);
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
      return c.json(
        { error: "Too many requests", retryAfter: retryAfterSec },
        429
      );
    }
    return next();
  };
}
