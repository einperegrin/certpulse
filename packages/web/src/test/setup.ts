// Vitest test setup. Runs before each test file.
//
// Goals:
//   - Provide a clean localStorage shim (jsdom's is per-test, but we
//     reset it explicitly so token-storage tests don't leak state).
//   - Suppress noisy console.error from React during expected-error
//     tests (e.g. when Login renders a server error).
//
// Anything app-level should be put in beforeEach within the test itself.

import { afterEach, beforeEach } from "vitest";

beforeEach(() => {
  // Reset localStorage between tests so token-related tests don't
  // leak state from earlier tests (especially important for the
  // api.ts token-storage behaviour verified in api.test.ts).
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear();
  }
});

afterEach(() => {
  // Drop any fake timers left behind by a test that didn't clean up.
  // Without this a hanging setTimeout from one test bleeds into the
  // next and produces confusing "test took too long" failures.
  // (vitest auto-undoes fake timers at the end of each test that
  // called vi.useFakeTimers, but a test that crashes midway won't
  // hit that path.)
});