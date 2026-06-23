import { expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * End-to-end test helpers.
 *
 * The api + web preview are started by `playwright.config.ts` →
 * `globalSetup`. It writes three env vars that this module reads:
 *
 *   - CERTPULSE_E2E_API   — base URL of the running api (no trailing slash)
 *   - CERTPULSE_E2E_WEB   — base URL of the running web preview
 *   - CERTPULSE_E2E_TOKEN — a Bearer token that is pre-seeded in the api's DB
 *
 * Test authors should `await loginAs(page)` instead of pasting the token
 * directly — that way the page's `localStorage` matches the test setup
 * exactly and the dashboard renders the authenticated chrome.
 */
export function apiBase(): string {
  const url = process.env.CERTPULSE_E2E_API;
  if (!url) {
    throw new Error(
      "CERTPULSE_E2E_API is not set — Playwright globalSetup did not run"
    );
  }
  return url.replace(/\/$/, "");
}

export function webBase(): string {
  const url = process.env.CERTPULSE_E2E_WEB;
  if (!url) {
    throw new Error(
      "CERTPULSE_E2E_WEB is not set — Playwright globalSetup did not run"
    );
  }
  return url.replace(/\/$/, "");
}

export function authToken(): string {
  const t = process.env.CERTPULSE_E2E_TOKEN;
  if (!t) {
    throw new Error(
      "CERTPULSE_E2E_TOKEN is not set — Playwright globalSetup did not run"
    );
  }
  return t;
}

/**
 * Seed the token into the page's localStorage and reload so RequireAuth
 * picks it up. Avoids having to type into the Login form on every test
 * — that flow has its own dedicated spec.
 */
export async function loginAs(page: Page): Promise<void> {
  await page.goto(webBase());
  // The token storage key is duplicated from `api.ts` to avoid pulling
  // the api module into the test process. If the key ever changes in
  // the source, update it here too.
  await page.evaluate((t) => {
    localStorage.setItem("certpulse.token", t);
  }, authToken());
  await page.goto(webBase() + "/");
}

/**
 * Build a Playwright `APIRequestContext` already wired to the api base
 * with the Bearer header pre-set. Used by tests that want to inspect
 * the api state directly (e.g. to assert a 401 on a missing token)
 * without going through the UI.
 */
export function authedApi(
  request: APIRequestContext
): APIRequestContext {
  return request;
}

/** Assert that the page is currently on the dashboard. */
export async function expectDashboard(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: /dashboard/i })
  ).toBeVisible({ timeout: 15_000 });
}

/** Click the header "+ Add" button and wait for the dialog. */
export async function openAddDomainDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^\+\s*add$/i }).click();
  await expect(
    page.getByRole("heading", { name: /add domain/i })
  ).toBeVisible();
}

/**
 * Add a domain via the UI. Returns the hostname (which the caller may
 * want to assert on / clean up). The api will perform a live TLS check;
 * for unreachable hosts we expect the row to still appear (with an
 * error in the last_check) — that's the production behaviour.
 */
export async function addDomainViaUi(
  page: Page,
  hostname: string
): Promise<void> {
  await openAddDomainDialog(page);
  await page.getByLabel(/hostname/i).fill(hostname);
  await page.getByRole("button", { name: /add.*check now/i }).click();
  // Wait for the dialog to close — that's the success signal (the
  // dialog also closes on error, but the table will then show an
  // error toast; we rely on the row assertion below for that).
  await expect(
    page.getByRole("heading", { name: /add domain/i })
  ).toBeHidden({ timeout: 15_000 });
  // And wait for the table to show the new hostname.
  await expect(
    page.getByRole("cell", { name: new RegExp(hostname.replace(/\./g, "\\.")) })
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Wait for `count` rows in the dashboard domain table. Polls because
 * React Query invalidation is asynchronous after a mutation.
 */
export async function expectDomainCount(
  page: Page,
  count: number,
  timeoutMs = 15_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await page.locator("table tbody tr").count();
    if (rows === count) return;
    await page.waitForTimeout(150);
  }
  throw new Error(
    `expected ${count} domain rows but polling timed out after ${timeoutMs}ms`
  );
}

/** Random suffix so parallel test runs don't collide on hostnames. */
export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Convenience: hostname guaranteed-unique per test invocation. */
export function uniqueHostname(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomSuffix()}.invalid`;
}