import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  apiBase,
  authToken,
  loginAs,
  uniqueHostname,
} from "./helpers";

/**
 * E2E for the alert-channels editor on the domain detail page.
 *
 * Strategy: seed a domain via the api, navigate via the dashboard,
 * then exercise the channels editor. Channels tests don't need a
 * real TLS check to be valid — the editor talks to /api/domains/:id/channels
 * independently of the check pipeline.
 */
test.describe("Alert channels editor", () => {
  test("can add and remove a webhook channel", async ({ page, request }) => {
    const hostname = uniqueHostname("e2e-ch");
    const id = await seedDomain(request, hostname);

    await loginAs(page);
    // Match the FULL hostname in the table cell — prefix-only
    // matches collide with sibling test rows. (The dashboard list
    // is per-run, but tests share a single Playwright worker that
    // runs them in sequence, so earlier rows can still be visible.)
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));

    // The channels editor has a row of "add" buttons — one per
    // available channel kind. Click the webhook one.
    await page.getByRole("button", { name: /generic webhook/i }).click();

    // Form fields appear.
    const urlInput = page.getByPlaceholder(/https:\/\/example\.com\/hook/i);
    await expect(urlInput).toBeVisible();
    await urlInput.fill("https://example.invalid/hook");
    await page.getByRole("button", { name: /^save$/i }).click();

    // The row appears with the description "→ https://example.invalid/hook".
    await expect(
      page.getByText(/example\.invalid\/hook/i)
    ).toBeVisible({ timeout: 10_000 });

    // Remove it — the Trash icon button on the channel row.
    const channelRow = page.locator("li", { hasText: /example\.invalid\/hook/i }).first();
    await channelRow.getByRole("button").click();
    await expect(
      page.getByText(/example\.invalid\/hook/i)
    ).toBeHidden({ timeout: 10_000 });

    await cleanupDomain(request, id);
  });

  test("can add an email channel", async ({ page, request }) => {
    const hostname = uniqueHostname("e2e-email");
    const id = await seedDomain(request, hostname);

    await loginAs(page);
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));

    await page.getByRole("button", { name: /email/i }).click();
    const toInput = page.getByPlaceholder(/alerts@example\.com/i);
    await expect(toInput).toBeVisible();
    await toInput.fill("e2e@example.invalid");
    await page.getByRole("button", { name: /^save$/i }).click();

    await expect(
      page.getByText(/e2e@example\.invalid/i)
    ).toBeVisible({ timeout: 10_000 });

    await cleanupDomain(request, id);
  });
});

async function seedDomain(
  request: APIRequestContext,
  hostname: string
): Promise<number> {
  const res = await request.post(`${apiBase()}/api/domains`, {
    headers: { Authorization: `Bearer ${authToken()}` },
    data: { hostname, port: 443 },
  });
  if (!res.ok()) {
    throw new Error(`seed failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { domain: { id: number } };
  return body.domain.id;
}

async function cleanupDomain(
  request: APIRequestContext,
  id: number
): Promise<void> {
  await request.delete(`${apiBase()}/api/domains/${id}`, {
    headers: { Authorization: `Bearer ${authToken()}` },
  });
}