import { test, expect } from "@playwright/test";
import {
  apiBase,
  authToken,
  loginAs,
  uniqueHostname,
} from "./helpers";

/**
 * E2E for the domain detail page + the "Check Now" / delete actions.
 *
 * Strategy: seed via the api (faster + deterministic), drive the UI.
 */
test.describe("Domain detail", () => {
  test("renders the detail page with cert info + check history", async ({
    page,
  }) => {
    const hostname = uniqueHostname("e2e-detail-info");
    const id = await seedDomain(hostname);

    await loginAs(page);
    // Use the FULL hostname in the cell selector — prefix-only
    // matches collide with sibling test rows. (v0.5 / Bug 4-shaped
    // regression: tests started failing as soon as a previous run
    // left rows behind in the same DB.)
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));

    // Heading shows the hostname.
    await expect(
      page.getByRole("heading", { name: new RegExp(hostname.split("-")[0]) })
    ).toBeVisible();

    // TLS Certificate card is present.
    await expect(page.getByText(/tls certificate/i)).toBeVisible();
    // Domain Registration card is present.
    await expect(page.getByText(/domain registration/i)).toBeVisible();
    // Check History table heading is present.
    await expect(page.getByText(/check history/i)).toBeVisible();

    // Channels editor is present — use the heading role so we don't
    // match the empty-state copy ("No alert channels configured. Add
    // one below.") which also contains the phrase.
    await expect(
      page.getByRole("heading", { name: /alert channels/i })
    ).toBeVisible();

    await cleanupDomainById(id);
  });

  test("'Check Now' button triggers a new check", async ({ page }) => {
    const hostname = uniqueHostname("e2e-check");
    const id = await seedDomain(hostname);

    await loginAs(page);
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));

    // Read the current check count, click Check Now, read again.
    const before = await getCheckCount(id);

    await page.getByRole("button", { name: /check now/i }).click();

    // Poll the api (the row count is the source of truth — the UI
    // shows check history but the polling interval there is too
    // slow to be reliable in a test).
    await waitForCheckCount(id, before + 1);

    await cleanupDomainById(id);
  });

  test("'Delete' button removes the domain and returns to dashboard", async ({
    page,
  }) => {
    const hostname = uniqueHostname("e2e-delete");
    const id = await seedDomain(hostname);

    await loginAs(page);
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));

    // Auto-accept the native confirm() dialog.
    page.on("dialog", (d) => d.accept());

    await page.getByRole("button", { name: /^delete$/i }).click();

    await expect(page).toHaveURL(/\/$/);
    // And it's gone from the api.
    const { request } = await import("@playwright/test");
    const ctx = await request.newContext({
      baseURL: apiBase(),
      extraHTTPHeaders: { Authorization: `Bearer ${authToken()}` },
    });
    const list = await ctx.get("/api/domains");
    const body = (await list.json()) as { domains: { id: number }[] };
    expect(body.domains.find((d) => d.id === id)).toBeUndefined();
    await ctx.dispose();
  });
});

async function seedDomain(hostname: string): Promise<number> {
  const { request } = await import("@playwright/test");
  const ctx = await request.newContext({
    baseURL: apiBase(),
    extraHTTPHeaders: { Authorization: `Bearer ${authToken()}` },
  });
  const res = await ctx.post("/api/domains", {
    data: { hostname, port: 443 },
  });
  if (!res.ok()) {
    throw new Error(`seed failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { domain: { id: number } };
  await ctx.dispose();
  return body.domain.id;
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

async function getCheckCount(id: number): Promise<number> {
  const { request } = await import("@playwright/test");
  const ctx = await request.newContext({
    baseURL: apiBase(),
    extraHTTPHeaders: { Authorization: `Bearer ${authToken()}` },
  });
  const res = await ctx.get(`/api/domains/${id}`);
  const body = (await res.json()) as { checks: unknown[] };
  await ctx.dispose();
  return body.checks.length;
}

async function waitForCheckCount(
  id: number,
  expected: number,
  timeoutMs = 15_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await getCheckCount(id)) === expected) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `check count did not reach ${expected} within ${timeoutMs}ms`
  );
}