import { test, expect } from "@playwright/test";
import { apiBase, webBase, authToken } from "./helpers";

test.describe("Authentication (Bug 2 fix)", () => {
  test("redirects to /login when no token is set", async ({ page }) => {
    await page.goto(webBase());
    // Visit a protected route — RequireAuth should bounce us.
    await page.goto(webBase() + "/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("heading", { name: /sign in to certpulse/i })
    ).toBeVisible();
  });

  test("Login page rejects an invalid token with a 401 message", async ({
    page,
  }) => {
    await page.goto(webBase() + "/login");
    await page.getByTestId("login-token-input").fill("cp_definitely_not_real");
    await page.getByTestId("login-submit").click();

    // The Login component probes /api/domains — that endpoint requires
    // auth, so a wrong token must produce a 401 and the form must
    // surface the "rejected" message. The friendly text comes from the
    // api.ts error handler we verified in the unit suite.
    await expect(page.getByTestId("login-error")).toContainText(/401|rejected/i, {
      timeout: 10_000,
    });
    // Token must NOT have been persisted — the user should be able to
    // try again without first clearing devtools.
    const stored = await page.evaluate(() =>
      window.localStorage.getItem("certpulse.token")
    );
    expect(stored).toBeNull();
  });

  test("Login page accepts a valid token and lands on the dashboard", async ({
    page,
  }) => {
    await page.goto(webBase() + "/login");
    await page.getByTestId("login-token-input").fill(authToken());
    await page.getByTestId("login-submit").click();

    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /^dashboard$/i })
    ).toBeVisible();
    // Token must now be in localStorage.
    const stored = await page.evaluate(() =>
      window.localStorage.getItem("certpulse.token")
    );
    expect(stored).toBe(authToken());
  });

  test("token persists across page reloads", async ({ page }) => {
    await page.goto(webBase() + "/login");
    await page.getByTestId("login-token-input").fill(authToken());
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/\/$/);
    await page.reload();
    // Still on the dashboard, NOT bounced to /login.
    await expect(page).toHaveURL(/\/$/);
  });

  test("sign-out clears the token and returns to /login", async ({
    page,
    context,
  }) => {
    // Seed via the storage shortcut (same as loginAs) to focus this
    // test on the sign-out path.
    await page.goto(webBase());
    await page.evaluate((t) => {
      localStorage.setItem("certpulse.token", t);
    }, authToken());
    await page.goto(webBase() + "/");
    await expect(
      page.getByRole("heading", { name: /^dashboard$/i })
    ).toBeVisible();
    await page.getByTestId("signout-button").click();
    await expect(page).toHaveURL(/\/login$/);
    const stored = await page.evaluate(() =>
      window.localStorage.getItem("certpulse.token")
    );
    expect(stored).toBeNull();
  });

  test("api rejects requests without an Authorization header", async ({
    request,
  }) => {
    const res = await request.get(`${apiBase()}/api/domains`);
    expect(res.status()).toBe(401);
  });
});