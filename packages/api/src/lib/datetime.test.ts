/**
 * Tests for `toIsoString` — the SQLite-datetime → ISO-8601 normaliser.
 *
 * Why this exists
 * ---------------
 * SQLite's `datetime('now')` returns `"YYYY-MM-DD HH:MM:SS"` in UTC,
 * with no `Z` suffix. `new Date("2026-06-23 15:30:00")` parses this
 * as LOCAL time (per ECMA-262), so a UTC+2 browser renders
 * "2h ago" the moment a row is inserted. The fix is to never let a
 * SQLite-format datetime leave the API in that shape.
 *
 * (Roman's bug report, 2026-06-23. Task: pippin-20260623-certpulse-tz-cert-bugs.)
 */
import { describe, expect, it } from "vitest";
import { normalizeIsoDeep, toIsoString } from "./datetime.js";

describe("toIsoString", () => {
  it("returns null for null / undefined / empty", () => {
    expect(toIsoString(null)).toBeNull();
    expect(toIsoString(undefined)).toBeNull();
    expect(toIsoString("")).toBeNull();
  });

  it("appends Z to a SQLite-format datetime string (the bug)", () => {
    expect(toIsoString("2026-06-23 15:30:00")).toBe(
      "2026-06-23T15:30:00Z"
    );
  });

  it("preserves fractional seconds when present", () => {
    expect(toIsoString("2026-06-23 15:30:00.123")).toBe(
      "2026-06-23T15:30:00.123Z"
    );
  });

  it("passes through strings that already carry a Z suffix", () => {
    expect(toIsoString("2026-06-23T15:30:00.123Z")).toBe(
      "2026-06-23T15:30:00.123Z"
    );
    // Lowercase `z` should also pass through.
    expect(toIsoString("2026-06-23T15:30:00z")).toBe(
      "2026-06-23T15:30:00z"
    );
  });

  it("passes through strings with a numeric offset (e.g. +02:00)", () => {
    expect(toIsoString("2026-06-23T15:30:00+02:00")).toBe(
      "2026-06-23T15:30:00+02:00"
    );
    expect(toIsoString("2026-06-23T15:30:00-0500")).toBe(
      "2026-06-23T15:30:00-0500"
    );
  });

  it("is timezone-aware: parses to the same UTC instant regardless of locale", () => {
    // The CORE property of the fix: a SQLite datetime string and an
    // ISO datetime string written for the SAME instant must parse to
    // the same Date.getTime(). The bug was that SQLite format was
    // interpreted as local time, which shifted it by the browser's
    // UTC offset.
    const sqlite = toIsoString("2026-06-23 15:30:00")!;
    const iso = "2026-06-23T15:30:00Z";
    expect(new Date(sqlite).getTime()).toBe(new Date(iso).getTime());
  });
});

describe("normalizeIsoDeep", () => {
  it("normalises datetime strings inside a flat object", () => {
    const out = normalizeIsoDeep({
      checkedAt: "2026-06-23 15:30:00",
      valid: true,
      issuer: "Let's Encrypt",
    });
    expect(out).toEqual({
      checkedAt: "2026-06-23T15:30:00Z",
      valid: true,
      issuer: "Let's Encrypt",
    });
  });

  it("normalises datetime strings inside arrays", () => {
    const out = normalizeIsoDeep([
      { checkedAt: "2026-06-23 15:30:00" },
      { checkedAt: "2026-06-23 15:31:00" },
    ]);
    expect(out).toEqual([
      { checkedAt: "2026-06-23T15:30:00Z" },
      { checkedAt: "2026-06-23T15:31:00Z" },
    ]);
  });

  it("preserves non-string leaves (Date, Buffer, number, boolean)", () => {
    const d = new Date("2026-06-23T15:30:00Z");
    const buf = Buffer.from("hello");
    const out = normalizeIsoDeep({ d, buf, n: 42, b: true });
    expect(out.d).toBe(d);
    expect(out.buf).toBe(buf);
    expect(out.n).toBe(42);
    expect(out.b).toBe(true);
  });

  it("is a no-op for null / undefined / primitives", () => {
    expect(normalizeIsoDeep(null)).toBeNull();
    expect(normalizeIsoDeep(undefined)).toBeUndefined();
    expect(normalizeIsoDeep(42)).toBe(42);
    expect(normalizeIsoDeep("hello")).toBe("hello");
  });
});