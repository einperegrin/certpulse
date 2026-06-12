/**
 * Tests for the backup/restore CLI.
 *
 * Strategy: write to os.tmpdir() (mkdtempSync for isolation), shell out
 * to the same `tar` binary the CLI uses (no mocking), and clean up in
 * afterEach. Tests are small and fast (<2s) because the DB is in-memory
 * and the archive is tiny.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the DB module BEFORE importing the CLI so `getDb()` returns a
// stub and we don't touch the production database. The stub's
// `backup()` writes a small marker file at the destination so the
// resulting tarball is well-formed (it would be empty otherwise).
vi.mock("../db/index.js", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const stmt = { get: () => ({ c: 0 }) };
  return {
    getDb: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: {
        client: {
          prepare: () => stmt,
          backup: (dest: string) => {
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, "fake-sqlite-bytes");
            return Promise.resolve();
          },
        },
      },
    }),
    closeDb: () => {},
  };
});

import type { DB } from "../db/index.js";

import { createBackup, restoreBackup, redactEnv } from "./backup.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "certpulse-bkp-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("redactEnv", () => {
  it("replaces known secret keys with <redacted>", () => {
    const input = [
      "# a comment",
      "",
      "RESEND_API_KEY=re_abc123def",
      'ALERT_EMAIL_TO="ops@example.com"',
      "WEBHOOK_SECRET=hunter2",
      "GITHUB_TOKEN=ghp_xxxx",
      "DB_PASSWORD=secret",
      "ALLOWED=public_value",
      "CHECK_INTERVAL=60",
    ].join("\n");
    const out = redactEnv(input);
    expect(out).toContain("RESEND_API_KEY=<redacted>");
    expect(out).toContain('ALERT_EMAIL_TO="<redacted>"');
    expect(out).toContain("WEBHOOK_SECRET=<redacted>");
    expect(out).toContain("GITHUB_TOKEN=<redacted>");
    expect(out).toContain("DB_PASSWORD=<redacted>");
    expect(out).toContain("ALLOWED=public_value");
    expect(out).toContain("CHECK_INTERVAL=60");
    expect(out).toContain("# a comment");
  });

  it("preserves non-secret env vars untouched", () => {
    expect(redactEnv("FOO=bar\nLOG_LEVEL=info\n")).toBe("FOO=bar\nLOG_LEVEL=info\n");
  });

  it("leaves comments and blank lines alone", () => {
    const input = "# top\n\n# middle\nFOO=bar\n";
    expect(redactEnv(input)).toBe(input);
  });
});

describe("createBackup", () => {
  it("writes a tarball containing manifest + db + redacted env", async () => {
    const dbPath = join(workDir, "certpulse.db");
    writeFileSync(dbPath, "fake-db-bytes"); // overwritten by mock .backup() in our setup
    const envPath = join(workDir, ".env");
    writeFileSync(
      envPath,
      [
        "RESEND_API_KEY=re_secret_value",
        "ALERT_EMAIL_TO=ops@example.com",
        "CHECK_INTERVAL=60",
      ].join("\n")
    );
    const out = await createBackup({
      outputPath: join(workDir, "out.tar.gz"),
      dbPath,
      envPath,
    });
    expect(existsSync(out)).toBe(true);
    const sz = statSync(out).size;
    expect(sz).toBeGreaterThan(50);

    // Extract and verify the manifest is valid JSON.
    const extractDir = mkdtempSync(join(tmpdir(), "certpulse-bkp-verify-"));
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("tar", ["-xzf", out, "-C", extractDir]);
    expect(r.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(extractDir, "manifest.json"), "utf8"));
    expect(manifest.version).toBeDefined();
    expect(manifest.createdAt).toBeDefined();
    expect(manifest.hostname).toBeDefined();
    expect(typeof manifest.checks).toBe("number");
    expect(typeof manifest.domains).toBe("number");
    expect(typeof manifest.alerts).toBe("number");
    expect(readFileSync(join(extractDir, ".env.redacted"), "utf8")).toContain("RESEND_API_KEY=<redacted>");
    expect(readFileSync(join(extractDir, ".env.redacted"), "utf8")).toContain("CHECK_INTERVAL=60");
    rmSync(extractDir, { recursive: true, force: true });
  });

  it("redacts env vars matching _KEY/_SECRET/_TOKEN/_PASSWORD", async () => {
    const dbPath = join(workDir, "certpulse.db");
    writeFileSync(dbPath, "fake");
    const envPath = join(workDir, ".env");
    writeFileSync(
      envPath,
      ["FOO_KEY=sk-1", "BAR_SECRET=abc", "BAZ_TOKEN=tk-1", "QUUX_PASSWORD=pw", "OPEN=ok"].join("\n")
    );
    const out = await createBackup({
      outputPath: join(workDir, "out.tar.gz"),
      dbPath,
      envPath,
    });
    const extractDir = mkdtempSync(join(tmpdir(), "certpulse-bkp-verify-"));
    const { spawnSync } = await import("node:child_process");
    spawnSync("tar", ["-xzf", out, "-C", extractDir]);
    const redacted = readFileSync(join(extractDir, ".env.redacted"), "utf8");
    expect(redacted).toContain("FOO_KEY=<redacted>");
    expect(redacted).toContain("BAR_SECRET=<redacted>");
    expect(redacted).toContain("BAZ_TOKEN=<redacted>");
    expect(redacted).toContain("QUUX_PASSWORD=<redacted>");
    expect(redacted).toContain("OPEN=ok");
    rmSync(extractDir, { recursive: true, force: true });
  });

  it("throws if the database file does not exist", async () => {
    await expect(
      createBackup({
        outputPath: join(workDir, "out.tar.gz"),
        dbPath: join(workDir, "missing.db"),
        envPath: join(workDir, ".env"),
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe("restoreBackup", () => {
  it("extracts a valid archive and reports the manifest without confirmation when --yes", async () => {
    // First create one
    const dbPath = join(workDir, "certpulse.db");
    writeFileSync(dbPath, "fake");
    const envPath = join(workDir, ".env");
    writeFileSync(envPath, "CHECK_INTERVAL=60\n");
    const archive = await createBackup({
      outputPath: join(workDir, "src.tar.gz"),
      dbPath,
      envPath,
    });
    // Now restore into a different dbPath
    const targetDb = join(workDir, "restore", "certpulse.db");
    const result = await restoreBackup({
      archivePath: archive,
      dbPath: targetDb,
      envPath: join(workDir, "restore", ".env"),
      yes: true,
    });
    expect(result.manifest.version).toBeDefined();
    expect(existsSync(targetDb)).toBe(true);
  });

  it("throws when the archive is missing manifest.json", async () => {
    // Make a tar that does NOT contain manifest.json. Need a real file
    // for tar to archive — tar exits 2 if any path is missing.
    writeFileSync(join(workDir, "sentinel.txt"), "x");
    const bogus = join(workDir, "bogus.tar.gz");
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("tar", ["-czf", bogus, "-C", workDir, "sentinel.txt"]);
    expect(r.status).toBe(0);
    await expect(
      restoreBackup({ archivePath: bogus, dbPath: join(workDir, "t.db"), envPath: join(workDir, ".env"), yes: true })
    ).rejects.toThrow(/manifest\.json/);
  });

  it("skips the confirmation prompt when --yes is set (no stdin read)", async () => {
    const dbPath = join(workDir, "certpulse.db");
    writeFileSync(dbPath, "fake");
    const envPath = join(workDir, ".env");
    writeFileSync(envPath, "FOO=bar\n");
    const archive = await createBackup({
      outputPath: join(workDir, "src2.tar.gz"),
      dbPath,
      envPath,
    });
    // confirmFn should never be called when yes: true
    const confirmFn = vi.fn(async () => true);
    await restoreBackup({
      archivePath: archive,
      dbPath: join(workDir, "restore2", "certpulse.db"),
      envPath: join(workDir, "restore2", ".env"),
      yes: true,
      confirmFn,
    });
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it("aborts when the user declines confirmation", async () => {
    const dbPath = join(workDir, "certpulse.db");
    writeFileSync(dbPath, "fake");
    const envPath = join(workDir, ".env");
    writeFileSync(envPath, "FOO=bar\n");
    const archive = await createBackup({
      outputPath: join(workDir, "src3.tar.gz"),
      dbPath,
      envPath,
    });
    const targetDb = join(workDir, "restore3", "certpulse.db");
    const result = await restoreBackup({
      archivePath: archive,
      dbPath: targetDb,
      envPath: join(workDir, "restore3", ".env"),
      confirmFn: async () => false,
    });
    expect(result.backedUp).toBeNull();
    expect(existsSync(targetDb)).toBe(false);
  });
});
