import { test, expect } from "@playwright/test";
import {
  apiBase,
  authToken,
  expectDashboard,
  expectDomainCount,
  loginAs,
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
    // Total Domains card label is unique enough to anchor against.
    await expect(page.getByText("Total Domains", { exact: true })).toBeVisible();
    await expect(page.getByText("Cert Expiring Soon", { exact: true })).toBeVisible();
    await expect(page.getByText("Cert Expired", { exact: true })).toBeVisible();
    await expect(page.getByText("Healthy", { exact: true })).toBeVisible();
    // Empty-state hint is shown when there are no domains yet.
    await expect(page.getByText(/no domains yet/i)).toBeVisible();
  });

  test("can add a domain via the UI", async ({ page }) => {
    const hostname = uniqueHostname("e2e-add");

    await page.getByRole("button", { name: /^\+\s*add$/i }).click();
    await expect(
      page.getByRole("heading", { name: /add domain/i })
    ).toBeVisible();
    await page.getByLabel(/hostname/i).fill(hostname);
    await page.getByRole("button", { name: /add.*check now/i }).click();

    // Dialog should close on success.
    await expect(
      page.getByRole("heading", { name: /add domain/i })
    ).toBeHidden({ timeout: 15_000 });

    // The new domain appears in the table.
    await expect(page.getByRole("cell", { name: new RegExp(hostname.replace(/\./g, "\\.")) }))
      .toBeVisible({ timeout: 15_000 });

    // Cleanup so the test suite is deterministic. The DB is per-run
    // (see playwright.config.ts) so this is cosmetic, but it keeps
    // re-runs clean if someone re-uses the same DB path.
    await cleanupDomain(hostname);
  });

  test("table shows the check result (status badge or error) after add", async ({
    page,
  }) => {
    const hostname = uniqueHostname("e2e-result");
    await page.getByRole("button", { name: /^\+\s*add$/i }).click();
    await page.getByLabel(/hostname/i).fill(hostname);
    await page.getByRole("button", { name: /add.*check now/i }).click();
    // Wait for the row to render.
    const row = page.locator("table tbody tr", {
      hasText: hostname.split("-")[0],
    }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    // For an unreachable host the api records a check with an error;
    // for a reachable host it records daysRemaining. Either way, the
    // row must show some status indicator (StatusBadge component, or
    // the literal word "Error" in a cell). The exact text is
    // environment-dependent — we just require the row to be present
    // and the Status cell to be non-empty.
    const statusCell = row.locator("td").nth(5);
    await expect(statusCell).not.toBeEmpty();

    await cleanupDomain(hostname);
  });

  test("clicking a row navigates to the domain detail page", async ({
    page,
  }) => {
    const hostname = uniqueHostname("e2e-detail");
    // Seed a domain via the API so we don't have to wait for a real
    // TLS handshake (unreachable hosts are slow but stable; the seed
    // path is faster and more deterministic).
    const id = await seedDomain(hostname);

    await page.goto(apiBase() + "/" /* noop, just warms the page */);
    await loginAs(page);
    await expectDashboard(page);

    // Click the row containing this hostname.
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));
    // Detail page shows the hostname in the page H1.
    await expect(
      page.getByRole("heading", { name: new RegExp(hostname.split("-")[0]) })
    ).toBeVisible();

    await cleanupDomainById(id);
  });
});

async function seedDomain(hostname: string): Promise<number> {
  // Imported lazily to avoid pulling node-fetch into the spec file.
  const { request } = await import("@playwright/test");
  const ctx = await request.newContext({
    baseURL: apiBase(),
    extraHTTPHeaders: { Authorization: `Bearer ${authToken()}` },
  });
  const res = await ctx.post("/api/domains", {
    data: { hostname, port: 443 },
  });
  if (!res.ok()) {
    throw new Error(
      `seed failed: ${res.status()} ${await res.text()}`
    );
  }
  const body = (await res.json()) as { domain: { id: number } };
  await ctx.dispose();
  return body.domain.id;
}

async function cleanupDomain(hostname: string): Promise<void> {
  const { request } = await import("@playwright/test");
  const ctx = await request.newContext({
    baseURL: apiBase(),
    extraHTTPHeaders: { Authorization: `Bearer ${authToken()}` },
  });
  // Find the id first (delete-by-hostname isn't exposed).
  const list = await ctx.get("/api/domains");
  const body = (await list.json()) as {
    domains: { id: number; hostname: string }[];
  };
  const match = body.domains.find((d) => d.hostname === hostname);
  if (match) await ctx.delete(`/api/domains/${match.id}`);
  await ctx.dispose();
}

async function cleanupDomainById(id: number): Promise<void> {
  const { request } = await import("@playwright/test");
  const ctx = await request.newContext({
    baseURL: apiBase(),
    extraHTTPHeaders: { Authorization: `Bearer ${authToken()}` },
  });
  await ctx.delete(`/api/domains/${id}`);
  await ctx.dispose();
}