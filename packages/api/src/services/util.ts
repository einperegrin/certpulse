/**
 * Coerce any thrown value to a string. Used by callers that previously
 * inlined `err instanceof Error ? err.message : String(err)` — the
 * pattern is identical in three places, so DRY it up. (v0.4.1
 * code-review HIGH — typed `(error as Error).message` patterns also
 * crash on non-Error throws.)
 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err === null || err === undefined) return String(err);
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
