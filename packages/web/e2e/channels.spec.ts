import { test, expect } from "@playwright/test";
import {
  apiBase,
  authToken,
  cleanupDomain,
  loginAs,
  seedDomain,
  uniqueHostname,
} from "./helpers";

test.describe("Alert channels editor", () => {
  test("can add and remove a webhook channel", async ({ page, request }) => {
    const hostname = uniqueHostname("e2e-ch");
    const id = await seedDomain(request, hostname);

    await loginAs(page);
    // Match the FULL hostname — prefix-only matches collide with sibling rows.
    const cellRe = new RegExp(hostname.replace(/\./g, "\\."));
    await page.getByRole("cell", { name: cellRe }).click();
    await expect(page).toHaveURL(new RegExp(`/domains/${id}`));

    await page.getByRole("button", { name: /generic webhook/i }).click();
    const urlInput = page.getByPlaceholder(/https:\/\/example\.com\/hook/i);
    await expect(urlInput).toBeVisible();
    await urlInput.fill("https://example.invalid/hook");
    await page.getByRole("button", { name: /^save$/i }).click();

    await expect(
      page.getByText(/example\.invalid\/hook/i)
    ).toBeVisible({ timeout: 10_000 });

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
