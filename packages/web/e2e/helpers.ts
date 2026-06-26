import { expect, type Page, type APIRequestContext } from "@playwright/test";

// E2E helpers. The api + web preview are started by playwright.config.ts
// → globalSetup, which stashes SSLERT_E2E_API / _WEB / _TOKEN in env.
export function apiBase(): string {
  const url = process.env.SSLERT_E2E_API;
  if (!url) {
    throw new Error(
      "SSLERT_E2E_API is not set — Playwright globalSetup did not run"
    );
  }
  return url.replace(/\/$/, "");
}

export function webBase(): string {
  const url = process.env.SSLERT_E2E_WEB;
  if (!url) {
    throw new Error(
      "SSLERT_E2E_WEB is not set — Playwright globalSetup did not run"
    );
  }
  return url.replace(/\/$/, "");
}

export function authToken(): string {
  const t = process.env.SSLERT_E2E_TOKEN;
  if (!t) {
    throw new Error(
      "SSLERT_E2E_TOKEN is not set — Playwright globalSetup did not run"
    );
  }
  return t;
}

// Seed the token into the page's localStorage and reload so RequireAuth
// picks it up. Avoids having to type into the Login form on every test.
export async function loginAs(page: Page): Promise<void> {
  await page.goto(webBase());
  // Key duplicates the one in api.ts; keep both in sync.
  await page.evaluate((t) => {
    localStorage.setItem("sslert.token", t);
  }, authToken());
  await page.goto(webBase() + "/");
}

export async function expectDashboard(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: /dashboard/i })
  ).toBeVisible({ timeout: 15_000 });
}

export async function openAddDomainDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^\+\s*add$/i }).click();
  await expect(
    page.getByRole("heading", { name: /add domain/i })
  ).toBeVisible();
}

// Create a domain via the api and return its id.
export async function seedDomain(
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

// Delete a domain by id (delete-by-hostname isn't exposed by the api).
export async function cleanupDomain(
  request: APIRequestContext,
  id: number
): Promise<void> {
  await request.delete(`${apiBase()}/api/domains/${id}`, {
    headers: { Authorization: `Bearer ${authToken()}` },
  });
}

// Delete a domain by hostname — look up the id first.
export async function cleanupDomainByHostname(
  request: APIRequestContext,
  hostname: string
): Promise<void> {
  const list = await request.get(`${apiBase()}/api/domains`, {
    headers: { Authorization: `Bearer ${authToken()}` },
  });
  const body = (await list.json()) as {
    domains: { id: number; hostname: string }[];
  };
  const match = body.domains.find((d) => d.hostname === hostname);
  if (match) await cleanupDomain(request, match.id);
}

// Wait for `count` rows in the dashboard domain table.
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

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function uniqueHostname(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomSuffix()}.invalid`;
}
