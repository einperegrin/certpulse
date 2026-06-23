/**
 * Playwright globalTeardown for @certpulse/web E2E tests (v0.5).
 *
 * Playwright also requires `globalTeardown` in the config to be a
 * STRING path. This module is responsible for killing the api and web
 * preview child processes started by `playwright.global-setup.ts` and
 * for cleaning up the temporary directory.
 */

import { existsSync, rmSync } from "node:fs";

declare global {
  // eslint-disable-next-line no-var
  var __certpulseE2E:
    | {
        apiProcess: import("node:child_process").ChildProcess;
        webProcess: import("node:child_process").ChildProcess;
        apiBase: string;
        webBase: string;
        token: string;
        dbPath: string;
        tempDir: string;
      }
    | undefined;
}

export default async function globalTeardown(): Promise<void> {
  const g = globalThis.__certpulseE2E;
  if (!g) return;
  for (const p of [g.apiProcess, g.webProcess]) {
    if (p && !p.killed) {
      try {
        p.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
  // Give processes up to 5s to die cleanly.
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of [g.apiProcess, g.webProcess]) {
    if (p && !p.killed) {
      try {
        p.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  if (g.tempDir && existsSync(g.tempDir)) {
    try {
      rmSync(g.tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}