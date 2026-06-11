/**
 * Backup & restore CLI for CertPulse (v0.4 / M-7).
 *
 * Usage:
 *   tsx src/cli/backup.ts create [output-path] [--db-path <p>] [--env-path <p>]
 *   tsx src/cli/backup.ts restore <archive-path> [--db-path <p>] [--env-path <p>] [--yes]
 *
 * A backup is a single tar.gz containing:
 *   manifest.json             {"version","createdAt","hostname","checks","domains","alerts"}
 *   data/certpulse.db         the SQLite file (snapshot via the .backup API)
 *   .env.redacted             copy of .env with secrets replaced by "<redacted>"
 *   README.md                 one-liner restore instructions
 *
 * The CLI shells out to `tar` via node:child_process — no new dependencies
 * (the task brief allows this and `tar` is a hard runtime dep of the
 * Docker image anyway).
 */
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { closeDb, getDb, type DB } from "../db/index.js";
import { sql } from "drizzle-orm";

/* ------------------------------------------------------------------ */
/* Argument parsing — tiny manual parser, mirrors the tokens.ts style. */
/* ------------------------------------------------------------------ */

function getArg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function defaultDbPath(): string {
  return process.env.DB_PATH ?? "/app/data/certpulse.db";
}

function defaultEnvPath(): string {
  // CWD-relative `.env` is the developer-friendly default; containerized
  // deploys typically mount the env file at `/app/.env` or the API's
  // CWD. The flag is the escape hatch.
  return process.env.ENV_PATH ?? join(process.cwd(), ".env");
}

function defaultBackupFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  return `certpulse-backup-${ts}.tar.gz`;
}

/* ------------------------------------------------------------------ */
/* Manifest — describes the contents of a backup archive.             */
/* ------------------------------------------------------------------ */

interface BackupManifest {
  version: string;
  createdAt: string;
  hostname: string;
  checks: number;
  domains: number;
  alerts: number;
}

/**
 * Read counts for the manifest. The DB is the source of truth, so the
 * numbers reflect the live state at backup time.
 */
function gatherManifest(db: DB): BackupManifest {
  const count = (q: ReturnType<typeof sql>): number => {
    const row = db.run(q as unknown as ReturnType<typeof sql>);
    // The "SELECT count(*) AS c FROM <table>" query is rendered into a
    // better-sqlite3 row; grab the first column off the first row.
    return 0;
  };
  // Drizzle doesn't have a clean `count(*)` helper that returns a scalar
  // synchronously across all versions, so we use raw SQL via `db.run`
  // and the prepared statement API.
  const tableCount = (table: string): number => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (db as any).session?.client ?? (db as any).$client;
    if (raw && typeof raw.prepare === "function") {
      const stmt = raw.prepare(`SELECT count(*) AS c FROM ${table}`);
      const row = stmt.get() as { c: number } | undefined;
      return Number(row?.c ?? 0);
    }
    return 0;
  };
  return {
    version: process.env.npm_package_version ?? "0.4.0",
    createdAt: new Date().toISOString(),
    hostname: osHostname(),
    checks: tableCount("checks"),
    domains: tableCount("domains"),
    alerts: tableCount("alerts"),
  };
}

/* ------------------------------------------------------------------ */
/* .env redaction — replace known secret keys with "<redacted>".      */
/* ------------------------------------------------------------------ */

const SECRET_PATTERNS = [
  /^RESEND_API_KEY$/i,
  /^ALERT_EMAIL_TO$/i,
  /_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
  /_PASSWORD$/i,
];

/**
 * Redact a .env file body. Lines matching the SECRET_PATTERNS list
 * have their value replaced by `<redacted>`. Comments, blank lines,
 * and unrelated variables are preserved verbatim. Quoted values keep
 * their quotes for syntactic round-tripping, but the inside is
 * replaced.
 */
export function redactEnv(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      if (line.trim() === "" || line.trim().startsWith("#")) return line;
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (!m) return line;
      const key = m[1]!;
      const value = m[2] ?? "";
      const isSecret = SECRET_PATTERNS.some((re) => re.test(key));
      if (!isSecret) return line;
      // Preserve surrounding quotes if the value had them.
      const trimmed = value.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return `${key}="<redacted>"`;
      }
      if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return `${key}='<redacted>'`;
      }
      return `${key}=<redacted>`;
    })
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* tar helpers — shell out to the system `tar` binary.                */
/* ------------------------------------------------------------------ */

function tarCreate(tarPath: string, sourceDir: string): Promise<void> {
  return new Promise((res, rej) => {
    const proc = spawn("tar", [
      "-czf",
      tarPath,
      "-C",
      sourceDir,
      "manifest.json",
      "data",
      ".env.redacted",
      "README.md",
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", rej);
    proc.on("close", (code) => {
      if (code === 0) res();
      else rej(new Error(`tar exited with code ${code}: ${stderr}`));
    });
  });
}

function tarExtract(tarPath: string, destDir: string): Promise<void> {
  return new Promise((res, rej) => {
    const proc = spawn("tar", [
      "-xzf",
      tarPath,
      "-C",
      destDir,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", rej);
    proc.on("close", (code) => {
      if (code === 0) res();
      else rej(new Error(`tar exited with code ${code}: ${stderr}`));
    });
  });
}

/* ------------------------------------------------------------------ */
/* Confirmation prompt — `--yes` skips it.                            */
/* ------------------------------------------------------------------ */

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

/* ------------------------------------------------------------------ */
/* create — produce a tar.gz backup.                                  */
/* ------------------------------------------------------------------ */

export interface CreateOptions {
  outputPath?: string;
  dbPath?: string;
  envPath?: string;
}

export async function createBackup(opts: CreateOptions = {}): Promise<string> {
  const outputPath = resolve(opts.outputPath ?? join(process.cwd(), defaultBackupFilename()));
  const dbPath = opts.dbPath ?? defaultDbPath();
  const envPath = opts.envPath ?? defaultEnvPath();

  if (!existsSync(dbPath)) {
    throw new Error(`Database file not found at ${dbPath}`);
  }

  const stagingDir = mkdtempSync(join(tmpdir(), "certpulse-backup-"));
  mkdirSync(join(stagingDir, "data"), { recursive: true });

  // 1. Snapshot the SQLite DB. The .backup API is the only safe way
  //    to copy a live SQLite database — `cp` may produce a corrupt
  //    copy if there's an active writer. We do NOT take an exclusive
  //    lock; the better-sqlite3 .backup handles concurrent writers
  //    internally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (getDb() as any).session?.client ?? (getDb() as any).$client;
  if (raw && typeof raw.backup === "function") {
    console.log(`[backup] snapshotting ${dbPath} -> ${join(stagingDir, "data", "certpulse.db")}`);
    await new Promise<void>((res, rej) => {
      raw.backup(join(stagingDir, "data", "certpulse.db"))
        .then(() => res())
        .catch((err: unknown) => rej(err));
    });
  } else {
    // Fallback for drizzle versions that don't expose the .backup client
    // directly — copy the file. The CLI is not the hot path; consistency
    // is best-effort here.
    console.warn("[backup] .backup() not available; falling back to cp");
    copyFileSync(dbPath, join(stagingDir, "data", "certpulse.db"));
  }

  // 2. Build the manifest.
  const manifest = gatherManifest(getDb());
  writeFileSync(
    join(stagingDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  // 3. Redact the .env. If there's no .env, write an empty placeholder
  //    so the archive always has the same shape.
  if (existsSync(envPath)) {
    const envBody = readFileSync(envPath, "utf8");
    writeFileSync(join(stagingDir, ".env.redacted"), redactEnv(envBody));
  } else {
    writeFileSync(
      join(stagingDir, ".env.redacted"),
      "# No .env file was present at backup time\n"
    );
  }

  // 4. README — one-liner restore.
  writeFileSync(
    join(stagingDir, "README.md"),
    [
      "# CertPulse backup",
      "",
      `Created: ${manifest.createdAt} on ${manifest.hostname}`,
      `Version: ${manifest.version}`,
      "",
      "## Restore",
      "",
      "    certpulse backup restore " +
        outputPath.split("/").pop() +
        " --yes",
      "",
      "The restore command backs up the current DB to",
      "`certpulse.db.pre-restore` before overwriting it.",
      "",
    ].join("\n")
  );

  // 5. tar it up.
  await tarCreate(outputPath, stagingDir);

  const size = statSync(outputPath).size;
  console.log(
    `[backup] wrote ${outputPath} (${(size / 1024).toFixed(1)} KiB) — ${manifest.domains} domain(s), ${manifest.checks} check(s), ${manifest.alerts} alert(s)`
  );

  // 6. Clean up staging. Don't leave tempdirs behind.
  rmSync(stagingDir, { recursive: true, force: true });

  // The CLI may have opened the singleton DB. Close it so a subsequent
  // `restore` (or any other process) can move the file freely.
  try {
    closeDb();
  } catch {
    /* not open */
  }

  return outputPath;
}

/* ------------------------------------------------------------------ */
/* restore — extract an archive into the live DB location.            */
/* ------------------------------------------------------------------ */

export interface RestoreOptions {
  archivePath: string;
  dbPath?: string;
  envPath?: string;
  yes?: boolean;
  // The optional `confirm` injection makes this testable without
  // monkey-patching process.stdin. The CLI uses the default
  // (readline-based) prompt.
  confirmFn?: () => Promise<boolean>;
}

export interface RestoreResult {
  manifest: BackupManifest;
  backedUp: string | null;
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const archivePath = resolve(opts.archivePath);
  const dbPath = opts.dbPath ?? defaultDbPath();
  const envPath = opts.envPath ?? defaultEnvPath();

  if (!existsSync(archivePath)) {
    throw new Error(`Archive not found at ${archivePath}`);
  }

  const extractDir = mkdtempSync(join(tmpdir(), "certpulse-restore-"));
  await tarExtract(archivePath, extractDir);

  const manifestPath = join(extractDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    rmSync(extractDir, { recursive: true, force: true });
    throw new Error("Archive is missing manifest.json — not a valid CertPulse backup");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;

  console.log(`[restore] archive:  ${archivePath}`);
  console.log(`[restore] manifest: version=${manifest.version} created=${manifest.createdAt} host=${manifest.hostname}`);
  console.log(`[restore] contents: ${manifest.domains} domain(s), ${manifest.checks} check(s), ${manifest.alerts} alert(s)`);
  console.log(`[restore] target:   ${dbPath}`);

  if (!opts.yes) {
    const confirmFn = opts.confirmFn ?? (() => confirm("Proceed with restore? [y/N] "));
    const ok = await confirmFn();
    if (!ok) {
      console.log("[restore] aborted by user");
      rmSync(extractDir, { recursive: true, force: true });
      return { manifest, backedUp: null };
    }
  }

  // Back up the existing DB before clobbering it.
  let backedUp: string | null = null;
  if (existsSync(dbPath)) {
    backedUp = `${dbPath}.pre-restore`;
    console.log(`[restore] backing up existing DB to ${backedUp}`);
    try {
      copyFileSync(dbPath, backedUp);
    } catch (err) {
      rmSync(extractDir, { recursive: true, force: true });
      throw new Error(`Failed to back up existing database: ${(err as Error).message}`);
    }
  }

  // Close the singleton DB so the file handle is released; the move
  // below would fail on Windows (and on Linux when the process is
  // still holding a writable fd into the WAL).
  try {
    closeDb();
  } catch {
    /* not open */
  }

  // Copy the extracted DB over the live location. mkdir -p the
  // destination dir in case it's the first time the path exists.
  const targetDir = dirname(dbPath);
  if (targetDir && !existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }
  const srcDb = join(extractDir, "data", "certpulse.db");
  if (!existsSync(srcDb)) {
    rmSync(extractDir, { recursive: true, force: true });
    throw new Error("Archive is missing data/certpulse.db");
  }
  console.log(`[restore] installing ${srcDb} -> ${dbPath}`);
  copyFileSync(srcDb, dbPath);

  // Copy the redacted .env next to the live one. We DO NOT overwrite
  // an existing .env silently — that's a config change the operator
  // should make explicitly. Instead, drop a `.env.restored` next to
  // the configured env path with the redacted shape, so the operator
  // can `diff` and apply the missing keys manually.
  const srcEnv = join(extractDir, ".env.redacted");
  if (existsSync(srcEnv)) {
    const restoredEnvPath = `${envPath}.restored`;
    writeFileSync(restoredEnvPath, readFileSync(srcEnv, "utf8"));
    console.log(`[restore] wrote redacted .env to ${restoredEnvPath} (merge manually — existing .env not overwritten)`);
  }

  rmSync(extractDir, { recursive: true, force: true });

  console.log(`[restore] done${backedUp ? `. Previous DB preserved at ${backedUp}` : ""}`);
  return { manifest, backedUp };
}

/* ------------------------------------------------------------------ */
/* main — argv dispatch.                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const cmd = process.argv[2];
  if (cmd === "create") {
    const outputPath = process.argv[3] && !process.argv[3].startsWith("--")
      ? process.argv[3]
      : undefined;
    const out = await createBackup({
      outputPath,
      dbPath: getArg("db-path") ?? undefined,
      envPath: getArg("env-path") ?? undefined,
    });
    console.log(out);
    process.exit(0);
  } else if (cmd === "restore") {
    const archivePath = process.argv[3];
    if (!archivePath || archivePath.startsWith("--")) {
      console.error("Error: <archive-path> is required for restore");
      process.exit(2);
    }
    await restoreBackup({
      archivePath,
      dbPath: getArg("db-path") ?? undefined,
      envPath: getArg("env-path") ?? undefined,
      yes: hasFlag("yes"),
    });
    process.exit(0);
  } else {
    console.error("Usage: tsx src/cli/backup.ts create [output-path] | restore <archive-path> [--yes]");
    process.exit(2);
  }
}

// Make the package re-export of the exports work even though
// `import.meta.url` differs between tsx and node directly.
const isDirect =
  typeof import.meta.url === "string" &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  main().catch((err) => {
    console.error("[backup] failed:", err.message);
    process.exit(1);
  });
}
