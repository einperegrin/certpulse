import { test, expect } from "@playwright/test";
import {
  apiBase,
  authToken,
  cleanupDomain,
  cleanupDomainByHostname,
  expectDashboard,
  loginAs,
  seedDomain,
  uniqueHostname,
} from "./helpers";

test.describe("Dashboard + Add Domain (the flow Roman tried)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page);
    await expectDashboard(page);
  });

  test("dashboard renders with summary cards and an empty-state table", async ({
    page,
  }) => {
    await expect(page.getByText("Total Domains", { exact: true })).toBeVisible();
    await expect(page.getByText("Cert Expiring Soon", { exact: true })).toBeVisible();
    await expect(page.getByText("Cert Expired", { exact: true })).toBeVisible();
    await expect(page.getByText("Healthy", { exact: true })).toBeVisible();
    await expect(page.getByText(/no domains yet/i)).toBeVisible();
  });

  test("can add a domain via the UI", async ({ page, request }) => {
    const hostname = uniqueHostname("e2e-add");

    await page.getByRole("button", { name: /^\+\s*add$/i }).click();
    await expect(
      page.getByRole("heading", { name: /add domain/i })
    ).toBeVisible();
    await page.getByLabel(/hostname/i).fill(hostname);
    await page.getByRole("button", { name: /add.*check now/i }).click();

    await expect(
      page.getByRole("heading", { name: /add domain/i })
    ).toBeHidden({ timeout: 15_000 });

    await expect(
      page.getByRole("cell", { name: new RegExp(hostname.replace(/\./g, "\\.")) })
    ).toBeVisible({ timeout: 15_000 });

    await cleanupDomainByHostname(request, hostname);
  });

  test("table shows a status indicator after add", async ({ page, request }) => {
    const hostname = uniqueHostname("e2e-result");
    await page.getByRole("button", { name: /^\+\s*add$/i }).click();
    await page.getByLabel(/hostname/i).fill(hostname);
    await page.getByRole("button", { name: /add.*check now/i }).click();
    const row = page.locator("table tbody tr", {
      hasText: hostname.split("-")[0],
    }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // For an unreachable host the api records an error; for a reachable
    // host, daysRemaining. Either way, the Status cell must be non-empty.
    const statusCell = row.locator("td").nth(5);
    await expect(statusCell).not.toBeEmpty();

    await cleanupDomainByHostname(request, hostname);
  });

  test("clicking a row navigates to the domain detail page", async ({
    page,
    request,
  }) => {
    const hostname = uniqueHostname("e2e-detail");
    const id = await seedDomain(request, hostname);

    await page.goto(apiBase() + "/" /* warm */);
    await loginAs(page);
    await expectDashboard(page);

    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));
    await expect(
      page.getByRole("heading", { name: new RegExp(hostname.split("-")[0]) })
    ).toBeVisible();

    await cleanupDomain(request, id);
  });
});
