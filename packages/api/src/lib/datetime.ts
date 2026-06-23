/**
 * Datetime normalization helpers.
 *
 * Why this exists
 * ---------------
 * SQLite's `datetime('now')` returns `"YYYY-MM-DD HH:MM:SS"` in UTC,
 * with no `Z` suffix and no offset. The frontend then does
 * `new Date("2026-06-23 15:30:00")`, and per the ECMA-262 spec a
 * date-only / space-separated string without a timezone designator
 * is parsed as **local time**, not UTC. In a UTC+2 browser that
 * turns an actual 15:30 UTC check into a 13:30 UTC instant, so the
 * "Last Check" column reads "2h ago" the moment the row is
 * inserted. (Roman's bug report, 2026-06-23.)
 *
 * The fix is to never let a SQLite-format datetime leave the API in
 * that form. `toIsoString` rewrites
 * `"YYYY-MM-DD HH:MM:SS[.fff]"` into `"YYYY-MM-DDTHH:MM:SS.fffZ"`.
 * Strings that already carry a timezone designator (any value
 * written by `new Date().toISOString()` or by `checker.ts` via
 * `notBefore.toISOString()`) are passed through unchanged.
 *
 * We do this in the route serialization layer (not at the DB layer)
 * because the DB is the source of truth — the same string can be
 * read by future jobs, CLIs, and migrations that don't want the
 * rewrite. Normalize on the way out, not on the way in.
 */

const HAS_TZ_TRAILING_OFFSET = /[+-]\d{2}:?\d{2}$/;
// `\d` so we don't trip on the literal `Z` written into a base64
// PEM blob; we only care about the end of the whole string.
const HAS_TZ_TRAILING_Z = /[zZ]$/;

export function toIsoString(value: string | null | undefined): string | null {
  if (!value) return null;
  // Already carries timezone info — leave alone.
  if (HAS_TZ_TRAILING_OFFSET.test(value) || HAS_TZ_TRAILING_Z.test(value)) {
    return value;
  }
  // SQLite `datetime('now')` shape: `YYYY-MM-DD HH:MM:SS` or
  // `YYYY-MM-DD HH:MM:SS.SSS` (fractional seconds optional).
  // Convert the space separator to `T` and append `Z` to mark UTC.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
    return value.replace(" ", "T") + "Z";
  }
  // Fallback: try to round-trip through `new Date`. If we can parse
  // it, emit a proper ISO string. If `Date` rejects it (returns
  // NaN), keep the original so callers can still see what was stored
  // instead of `null`.
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return value;
}

/**
 * Walk a plain object / array and normalize every datetime-looking
 * string value. Useful for ad-hoc serializers that don't have a
 * hand-rolled mapper. Skips nested objects that are clearly not
 * records (Date, Buffer, etc.).
 *
 * We only rewrite `string` leaves — anything that already parsed as
 * a non-string is left alone. This is intentionally conservative:
 * schema-specific mappers (see `routes/domains.ts`) are the
 * preferred path for production responses.
 */
export function normalizeIsoDeep<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) {
    return input.map((v) => normalizeIsoDeep(v)) as unknown as T;
  }
  if (typeof input === "string") {
    return toIsoString(input) as unknown as T;
  }
  if (typeof input !== "object") return input;
  if (input instanceof Date || Buffer.isBuffer(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = normalizeIsoDeep(v);
  }
  return out as T;
}
