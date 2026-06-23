import { test, expect } from "@playwright/test";
import {
  apiBase,
  authToken,
  cleanupDomain,
  loginAs,
  seedDomain,
  uniqueHostname,
} from "./helpers";

test.describe("Domain detail", () => {
  test("renders the detail page with cert info + check history", async ({
    page,
    request,
  }) => {
    const hostname = uniqueHostname("e2e-detail-info");
    const id = await seedDomain(request, hostname);

    await loginAs(page);
    // Match the FULL hostname — prefix-only matches collide with sibling rows.
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));

    await expect(
      page.getByRole("heading", { name: new RegExp(hostname.split("-")[0]) })
    ).toBeVisible();
    await expect(page.getByText(/tls certificate/i)).toBeVisible();
    await expect(page.getByText(/domain registration/i)).toBeVisible();
    await expect(page.getByText(/check history/i)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /alert channels/i })
    ).toBeVisible();

    await cleanupDomain(request, id);
  });

  test("'Check Now' button triggers a new check", async ({ page, request }) => {
    const hostname = uniqueHostname("e2e-check");
    const id = await seedDomain(request, hostname);

    await loginAs(page);
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));

    const before = await getCheckCount(request, id);
    await page.getByRole("button", { name: /check now/i }).click();
    await waitForCheckCount(request, id, before + 1);

    await cleanupDomain(request, id);
  });

  test("'Delete' button removes the domain and returns to dashboard", async ({
    page,
    request,
  }) => {
    const hostname = uniqueHostname("e2e-delete");
    const id = await seedDomain(request, hostname);

    await loginAs(page);
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));

    page.on("dialog", (d) => d.accept());

    // Filter on text "Delete" so we don't match icon-only row buttons.
    await page
      .getByRole("button", { name: /^delete$/i })
      .filter({ hasText: "Delete" })
      .click();

    await expect(page).toHaveURL(/\/$/);
    const list = await request.get(`${apiBase()}/api/domains`, {
      headers: { Authorization: `Bearer ${authToken()}` },
    });
    const body = (await list.json()) as { domains: { id: number }[] };
    expect(body.domains.find((d) => d.id === id)).toBeUndefined();
  });
});

async function getCheckCount(
  request: import("@playwright/test").APIRequestContext,
  id: number
): Promise<number> {
  const res = await request.get(`${apiBase()}/api/domains/${id}`, {
    headers: { Authorization: `Bearer ${authToken()}` },
  });
  const body = (await res.json()) as { checks: unknown[] };
  return body.checks.length;
}

async function waitForCheckCount(
  request: import("@playwright/test").APIRequestContext,
  id: number,
  expected: number,
  timeoutMs = 15_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await getCheckCount(request, id)) === expected) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `check count did not reach ${expected} within ${timeoutMs}ms`
  );
}
