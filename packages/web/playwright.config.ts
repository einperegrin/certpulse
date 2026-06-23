import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config for @certpulse/web (v0.5).
 *
 * What this config does:
 *
 *   1. `globalSetup` (in `playwright.global-setup.ts`) allocates a
 *      temporary SQLite database and a random API port, starts the
 *      @certpulse/api process against that DB with auth ENABLED (no
 *      AUTH_DISABLED), provisions one valid API token via direct DB
 *      insert, and starts `vite preview` so the web bundle is served.
 *      The tests run against the real production-style wiring (auth
 *      on, real Bearer token, real DB), not against a mock — which is
 *      exactly the behaviour that was broken in v0.4.x.
 *   2. `globalTeardown` (in `playwright.global-teardown.ts`) kills the
 *      api and web preview child processes and removes the temp dir.
 *
 * Playwright requires globalSetup and globalTeardown to be STRING
 * paths to modules, not inline async functions. The first revision of
 * this config tried inline functions and Playwright bailed at
 * config-validate with "globalSetup must be a string". The split is
 * mechanical, but if you need to change the bootstrap sequence, edit
 * the global-setup file, not this one.
 */

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false, // single-worker: tests share one API + DB
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  globalSetup: "./playwright.global-setup.ts",
  globalTeardown: "./playwright.global-teardown.ts",
});