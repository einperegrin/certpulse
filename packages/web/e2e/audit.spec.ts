import { test, expect } from "@playwright/test";
import { apiBase, authToken, loginAs, webBase } from "./helpers";

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

    await loginAs(page);
    await page.goto(webBase() + "/audit");

    await expect(
      page.getByRole("heading", { name: /^audit log$/i })
    ).toBeVisible();

    await expect(page.getByText(/domain\.create/).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/domain\.delete/).first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByLabel(/^action$/i).fill("domain.delete");
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
