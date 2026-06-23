import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiBase, authToken, loginAs, webBase } from "./helpers";

/**
 * E2E for the audit log page.
 *
 * Strategy: seed a couple of audit-emitting actions via the api, then
 * verify the dashboard reflects them and the action filter works.
 */
test.describe("Audit log", () => {
  test("renders recent audit entries and supports filtering by action", async ({
    page,
    request,
  }) => {
    // Seed two distinct actions: create + delete a domain.
    const create = await request.post(`${apiBase()}/api/domains`, {
      headers: { Authorization: `Bearer ${authToken()}` },
      data: { hostname: `e2e-audit-create-${Date.now()}.invalid`, port: 443 },
    });
    expect(create.ok()).toBeTruthy();
    const { domain } = (await create.json()) as { domain: { id: number } };
    await request.delete(`${apiBase()}/api/domains/${domain.id}`, {
      headers: { Authorization: `Bearer ${authToken()}` },
    });

    // Visit the audit page.
    await loginAs(page);
    await page.goto(webBase() + "/audit");

    await expect(
      page.getByRole("heading", { name: /^audit log$/i })
    ).toBeVisible();

    // We should see at least one of each of the seeded actions.
    // Use the row-level text — the action badge is the visible label.
    await expect(page.getByText(/domain\.create/).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/domain\.delete/).first()).toBeVisible({
      timeout: 15_000,
    });

    // Filter by action: type "domain.delete" into the action input.
    await page.getByLabel(/^action$/i).fill("domain.delete");

    // The create row should disappear; the delete row should remain.
    // (The action filter is debounced only by React Query — wait a beat.)
    await page.waitForTimeout(500);
    await expect(page.getByText(/domain\.create/).first()).toBeHidden({
      timeout: 10_000,
    });
    await expect(page.getByText(/domain\.delete/).first()).toBeVisible();
  });

  test("api /api/audit-log requires auth", async ({ request }) => {
    const res = await request.get(`${apiBase()}/api/audit-log`);
    expect(res.status()).toBe(401);
  });

  test("api /api/audit-log returns rows when authenticated", async ({
    request,
  }) => {
    const res = await request.get(`${apiBase()}/api/audit-log?limit=5`, {
      headers: { Authorization: `Bearer ${authToken()}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { rows: unknown[]; total: number };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.total).toBe("number");
  });
});

/**
 * Quietly silence the unused-import warning if a future maintainer
 * drops the seedDomain helper — typescript-only, no runtime cost.
 */
void ({} as APIRequestContext);