/**
 * E2E test for the timezone normalization bug (2026-06-23).
 *
 * Bug: SQLite `datetime('now')` returns `YYYY-MM-DD HH:MM:SS` without
 * a `Z` suffix. `new Date("2026-06-23 15:30:00")` is parsed as LOCAL
 * time (ECMA-262), so in a UTC+2 browser a check done at 15:30 UTC
 * reads as 13:30 UTC → "2h ago" the moment the row is inserted.
 *
 * Fix: `toIsoString()` in datetime.ts appends `Z` to SQLite-format
 * strings before they leave the API. The frontend's
 * `formatDistanceToNowStrict` then parses the timestamp as UTC and
 * computes the correct relative time.
 *
 * This E2E test seeds a domain, waits for a check to complete, and
 * asserts the "Last Check" column shows a recent relative time
 * (≤ 60s), not hours — which would indicate the timezone bug.
 */
import { test, expect } from "@playwright/test";
import {
  apiBase,
  authToken,
  cleanupDomainByHostname,
  loginAs,
  expectDashboard,
} from "./helpers";

test.describe("Timezone: last-check relative time (bug #5)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await expectDashboard(page);
  });

  test("'Last Check' shows seconds-ago, not hours-ago, right after a check", async ({
    page,
    request,
  }) => {
    // Use a real reachable host so a check actually completes.
    const hostname = "expired-rsa-dv.ssl.com";

    // Seed via API and trigger a check immediately.
    const createRes = await request.post(`${apiBase()}/api/domains`, {
      headers: { Authorization: `Bearer ${authToken()}` },
      data: { hostname, port: 443 },
    });
    expect(createRes.ok()).toBe(true);
    const body = (await createRes.json()) as { domain: { id: number } };
    const domainId = body.domain.id;

    // Wait for at least one check row to appear.
    const start = Date.now();
    let checkedAt: string | null = null;
    while (Date.now() - start < 20_000) {
      const res = await request.get(`${apiBase()}/api/domains/${domainId}`, {
        headers: { Authorization: `Bearer ${authToken()}` },
      });
      const detail = (await res.json()) as {
        checks: { checkedAt: string }[];
      };
      if (detail.checks.length > 0) {
        checkedAt = detail.checks[0].checkedAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(checkedAt).not.toBeNull();

    // The API should return an ISO 8601 string with `Z` suffix.
    // If the timezone bug is present, the string will be
    // `YYYY-MM-DD HH:MM:SS` (no Z) and JS will parse it as local time.
    expect(checkedAt).toMatch(/[zZ]$/);

    // Reload the dashboard so the new row renders.
    await page.goto(apiBase().replace(/\/api$/, "") + "/");
    await expectDashboard(page);

    // Find the row for our domain and check the "Last Check" cell
    // (column index 4 in the table — 0-indexed: Domain, Issuer,
    // Cert Days, Domain Days, Last Check, Status, Actions).
    const row = page.locator("table tbody tr", {
      hasText: hostname,
    }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    const lastCheckCell = row.locator("td").nth(4);
    const text = (await lastCheckCell.textContent())?.trim() ?? "";

    // The check just ran, so the relative time should be "just now"
    // or "Ns ago" / "Nsm ago" — NOT "Nh ago" or "Nd ago".
    // If the timezone bug is present, this would show "2h ago" (or
    // whatever the browser's UTC offset is) immediately.
    expect(text).not.toBe("—");
    expect(text).toMatch(/just now|^\d+s ago$|^\d+m ago$/);
    // Explicitly assert it's NOT hours ago — the bug signature.
    expect(text).not.toMatch(/h ago|d ago/);

    await cleanupDomainByHostname(request, hostname);
  });
});