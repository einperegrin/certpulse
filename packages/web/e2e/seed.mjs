// E2E seed: starts the api, waits for /health, seeds a Bearer token,
// then starts vite preview against a per-run api port and stashes the
// api base URL + token in process.env for spec files. SIGTERM
// (Playwright teardown) forwards to both children.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";

async function waitForOk(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 304) return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

export default async function globalSetup() {
  const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
  const apiDir = join(repoRoot, "packages", "api");
  const webDir = repoRoot;
  const tempDir = mkdtempSync(join(tmpdir(), "cp-e2e-"));
  const dbPath = join(tempDir, "certpulse.db");
  const apiPort = 31000 + Math.floor(Math.random() * 1000);
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const token = "cp_test_" + randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

  // 1) Start api with auth ENABLED against a fresh per-run SQLite DB.
  const api = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts"],
    {
      cwd: apiDir,
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(apiPort),
        DATABASE_PATH: dbPath,
        CHECK_INTERVAL: "1",
        LOG_LEVEL: process.env.CI ? "warn" : "info",
        // Permits E2E seed hostnames (*.invalid); production must keep this off.
        ALLOW_PRIVATE_HOSTS: "1",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await waitForOk(`${apiBase}/health`, 30000);

  // 2) Insert the seeded token via direct DB write (migrations have run).
  const db = new Database(dbPath);
  db.prepare(
    "INSERT INTO api_tokens (token_hash, label, expires_at, created_at) VALUES (?, ?, NULL, datetime('now'))",
  ).run(tokenHash, "playwright-e2e");
  db.close();

  // 3) Start vite preview. VITE_API_URL is wired so the SPA hits /api/* on
  //    the preview origin; the preview server proxies /api/* to the api.
  const web = spawn(
    process.execPath,
    [
      join(repoRoot, "node_modules", ".bin", "vite"),
      "preview",
      "--host", "127.0.0.1",
      "--port", "4173",
      "--strictPort",
    ],
    {
      cwd: webDir,
      env: { ...process.env, VITE_API_URL: apiBase },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await waitForOk("http://127.0.0.1:4173/", 15000);

  process.env["CERTPULSE_E2E_API"] = apiBase;
  process.env["CERTPULSE_E2E_TOKEN"] = token;
  process.env["CERTPULSE_E2E_DB"] = dbPath;
  process.env["CERTPULSE_E2E_TEMP"] = tempDir;

  process.on("SIGTERM", () => {
    api.kill("SIGTERM");
    web.kill("SIGTERM");
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });
}
