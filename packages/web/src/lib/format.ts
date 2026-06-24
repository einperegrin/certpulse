import { normalizeIsoForJs } from "./cert-errors";

export function formatDistanceToNowStrict(date: Date): string {
  const diff = Date.now() - date.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    // Defense in depth: the API now returns proper ISO 8601 with `Z`,
    // but if a stale SQLite-format string slips through (cached
    // payload, older deploys), we still want the date to render in
    // the user's local zone instead of "Invalid Date".
    return new Date(normalizeIsoForJs(iso)).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Wrap `formatDistanceToNowStrict` with the same defence-in-depth
 * normalization. Use this anywhere the UI renders "X ago" against a
 * backend timestamp. (Bug: 2026-06-23 — "2h ago" the moment a row
 * was inserted because `new Date("2026-06-23 15:30:00")` parsed as
 * local time in a UTC+2 browser. The API now normalizes on the way
 * out; this is the belt-and-suspenders fix.)
 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(normalizeIsoForJs(iso));
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNowStrict(d);
}
