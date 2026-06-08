import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20000,
    // Disable auth by default in the test suite so existing route tests
    // don't have to thread Authorization headers. The auth-middleware test
    // file unsets this and exercises the real path.
    env: {
      AUTH_DISABLED: "1",
    },
  },
});
