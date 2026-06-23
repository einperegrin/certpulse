/**
 * Playwright globalSetup for @certpulse/web E2E tests (v0.5).
 *
 * Playwright requires `globalSetup` in the config to be a STRING path
 * to a module (not an inline async function as was tried in the first
 * revision of this suite — that failed at config-validate with
 * "globalSetup must be a string"). This file is loaded by Playwright
 * once before any test file runs.
 *
 * What this script does:
 *
 *   1. Allocates a temporary SQLite database and a random API port.
 *   2. Starts the @certpulse/api process against that DB with auth
 *      ENABLED (no AUTH_DISABLED).
 *   3. Provisions one valid API token via direct DB insert (sha256 of
 *      the token, exactly what `certpulse token create` does).
 *   4. Runs `vite build` once before any test, then starts
 *      `vite preview` so the web bundle is served. The preview server
 *      has VITE_API_URL pointed at the local API process.
 *   5. Stashes the API base, web base, and the seeded token in
 *      process.env for the spec files to read via `helpers.ts`.
 *
 * The corresponding `playwright.global-teardown.ts` kills both child
 * processes and removes the temp directory.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

// Playwright loads this file as ESM (the package's package.json has
// `"type": "module"`), so __dirname is undefined. Recover it via
// import.meta.url.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

declare global {
  // eslint-disable-next-line no-var
  var __certpulseE2E:
    | {
        apiProcess: ChildProcess;
        webProcess: ChildProcess;
        apiBase: string;
        webBase: string;
        token: string;
        dbPath: string;
        tempDir: string;
      }
    | undefined;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function waitForHealth(base: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`api at ${base} never became healthy within ${timeoutMs}ms`);
}

async function waitForHttpOk(base: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/`);
      if (r.ok || r.status === 200 || r.status === 304) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`web at ${base} never responded within ${timeoutMs}ms`);
}

function runNode(
  cwd: string,
  args: string[],
  prefix: string | null
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (b) => {
      if (prefix) process.stdout.write(prefix + b);
    });
    child.stderr?.on("data", (b) => {
      process.stderr.write((prefix ?? "") + b);
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`command exited ${code}: ${args.join(" ")}`));
    });
    child.on("error", reject);
  });
}

async function seedTokenViaDirectDbInsert(
  dbPath: string,
  tokenHash: string
): Promise<void> {
  // Use better-sqlite3 from the api's installed deps. We do not want
  // to shell out to the CLI — Playwright tests would race on stdout
  // parsing. The api performs migrations on startup, which creates the
  // api_tokens table; we then write the row directly.
  const apiDir = join(__dirname, "..", "..", "packages", "api");
  const code = `
    import Database from "better-sqlite3";
    const db = new Database(${JSON.stringify(dbPath)});
    db.prepare(
      "INSERT INTO api_tokens (token_hash, label, expires_at, created_at) VALUES (?, ?, NULL, datetime('now'))"
    ).run(${JSON.stringify(tokenHash)}, "playwright-e2e");
    db.close();
  `;
  await runNode(apiDir, ["--input-type=module", "-e", code], null);
}

export default async function globalSetup(): Promise<void> {
  const repoRoot = join(__dirname, "..", "..");
  const apiDir = join(repoRoot, "packages", "api");
  const webDir = join(repoRoot, "packages", "web");

  // 1) Allocate ephemeral resources.
  const tempDir = mkdtempSync(join(tmpdir(), "certpulse-e2e-"));
  const dbPath = join(tempDir, "certpulse.db");
  const apiPort = 31000 + Math.floor(Math.random() * 1000);
  const webPort = 4173;

  // 2) Generate a token. The api will run migrations on startup which
  //    leaves api_tokens empty — we insert directly afterwards.
  const token = "cp_test_" + randomBytes(24).toString("base64url");
  const tokenHash = sha256Hex(token);

  // 3) Start the api with auth ENABLED (no AUTH_DISABLED). We use
  //    `tsx` to run the TS source directly so we don't need a build
  //    step for the api in tests. We also disable the SSRF guard so
  //    E2E tests can seed synthetic hostnames (`*.invalid` resolves
  //    to nothing, which the guard treats as a private/blocked range
  //    when followed). Production MUST keep ALLOW_PRIVATE_HOSTS off.
  const apiProcess = spawn(
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
        ALLOW_PRIVATE_HOSTS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  apiProcess.stdout?.on("data", (b) => {
    if (!process.env.CI) process.stdout.write(`[api] ${b}`);
  });
  apiProcess.stderr?.on("data", (b) => {
    process.stderr.write(`[api] ${b}`);
  });

  const apiBase = `http://127.0.0.1:${apiPort}`;
  await waitForHealth(apiBase, 30_000);

  // 4) Insert the seeded token via direct DB write.
  await seedTokenViaDirectDbInsert(dbPath, tokenHash);

  // 5) Build the web bundle once. The vite binary is hoisted to the
  //    repo root by npm workspaces, so we point at it directly.
  await runNode(
    webDir,
    [join(repoRoot, "node_modules", ".bin", "vite"), "build"],
    process.env.CI ? null : "[vite build] "
  );

  // 6) Start `vite preview` so the web SPA is served.
  const webProcess = spawn(
    process.execPath,
    [
      join(repoRoot, "node_modules", ".bin", "vite"),
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(webPort),
      "--strictPort",
    ],
    {
      cwd: webDir,
      env: {
        ...process.env,
        VITE_API_URL: apiBase,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  webProcess.stdout?.on("data", (b) => {
    if (!process.env.CI) process.stdout.write(`[web] ${b}`);
  });
  webProcess.stderr?.on("data", (b) => {
    process.stderr.write(`[web] ${b}`);
  });
  const webBase = `http://127.0.0.1:${webPort}`;
  await waitForHttpOk(webBase, 15_000);

  // Stash for spec files.
  process.env.CERTPULSE_E2E_API = apiBase;
  process.env.CERTPULSE_E2E_WEB = webBase;
  process.env.CERTPULSE_E2E_TOKEN = token;

  globalThis.__certpulseE2E = {
    apiProcess,
    webProcess,
    apiBase,
    webBase,
    token,
    dbPath,
    tempDir,
  };
}