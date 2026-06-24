import { defineConfig } from "vitest/config";

/**
 * Root Vitest config. The actual suite lives in `packages/api/`, but
 * `npm test` and the cron-driven test runs are launched from the repo
 * root — Vitest only picks up the per-package config if you `cd` into
 * `packages/api/` first. Mirroring `AUTH_DISABLED=*** here means both
 * entrypoints behave identically: route tests don't need to thread
 * Authorization headers, the auth-middleware test file unsets it
 * locally and exercises the real path.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Walk into the API package; the web package has no vitest specs
    // (its tests are Playwright e2e under packages/web/e2e/).
    include: ["packages/api/src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20000,
    env: {
      AUTH_DISABLED: "1",
    },
  },
});
