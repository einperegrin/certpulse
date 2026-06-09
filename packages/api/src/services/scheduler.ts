import cron, { type ScheduledTask } from "node-cron";
import { and, eq, sql } from "drizzle-orm";
import { type DB, getDb } from "../db/index.js";
import { schedulerState } from "../db/schema.js";
import { runChecksForAllEnabledDomains } from "./checker-runner.js";
import { runRetention } from "../jobs/retention.js";
import { logger } from "./logger.js";

let task: ScheduledTask | null = null;

// Stale-lock threshold. If the previous tick didn't release the lock
// within this window we assume it crashed and reclaim the lock. 30
// minutes is well above the longest expected tick (a few seconds for
// 10s of domains, much less in practice).
const TICK_TIMEOUT_MS = 30 * 60 * 1000;

export function getCheckIntervalMinutes(): number {
  const raw = process.env.CHECK_INTERVAL;
  if (!raw) return 60;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || n > 1440) return 60; // cap at 24h (M-10)
  return n;
}

export function buildCronExpression(intervalMinutes: number): string {
  if (intervalMinutes < 60) {
    return `*/${intervalMinutes} * * * *`;
  }
  const hours = Math.floor(intervalMinutes / 60);
  if (intervalMinutes % 60 === 0 && hours <= 23) {
    return `0 */${hours} * * *`;
  }
  return "0 * * * *";
}

/**
 * Format a JS Date as SQLite's `datetime('now')` format
 * (YYYY-MM-DD HH:MM:SS in UTC). The schema's DEFAULT clause uses this
 * format, so writing ISO-8601 with a `T` separator breaks lexicographic
 * text comparison in WHERE clauses (Copilot review: scheduler.ts:56).
 */
function sqliteNow(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/**
 * Atomic claim helper (H-3). Returns true if this caller now owns the
 * scheduler lock; false if a previous tick is still running. Crash-safe
 * because the lock is keyed in `scheduler_state` and stale after 30
 * minutes.
 */
function tryClaimSchedulerLock(db: DB): boolean {
  // Use a single UPDATE statement: SQLite is serialised, so the
  // transition is atomic. updatedAt is written in SQLite's datetime
  // format so it compares correctly against `datetime('now', '-30 minutes')`.
  const result = db
    .update(schedulerState)
    .set({ value: "1", updatedAt: sqliteNow() })
    .where(
      and(
        eq(schedulerState.key, "running"),
        sql`(${schedulerState.value} = '0' OR ${schedulerState.updatedAt} < datetime('now', '-30 minutes'))`
      )
    )
    .run();
  return result.changes > 0;
}

function releaseSchedulerLock(db: DB): void {
  db.update(schedulerState)
    .set({ value: "0", updatedAt: sqliteNow() })
    .where(eq(schedulerState.key, "running"))
    .run();
}

function setSchedulerState(db: DB, key: string, value: string): void {
  db.update(schedulerState)
    .set({ value, updatedAt: sqliteNow() })
    .where(eq(schedulerState.key, key))
    .run();
}

export async function tickChecks(
  db: DB = getDb(),
  options: {
    rejectUnauthorized?: boolean;
    timeoutMs?: number;
    concurrency?: number;
  } = {}
): Promise<{ ran: number; deduplicated?: boolean }> {
  // Seed the state row if it doesn't exist yet (older DBs pre-0004).
  // Wrapped in a best-effort try — INSERT OR IGNORE on PK violation is
  // the safe path.
  try {
    db.insert(schedulerState)
      .values({ key: "running", value: "0" })
      .onConflictDoNothing()
      .run();
  } catch {
    // ignore
  }

  if (!tryClaimSchedulerLock(db)) {
    logger.debug("tick skipped — previous tick still running");
    return { ran: 0, deduplicated: true };
  }
  const concurrency = options.concurrency ?? 10;
  try {
    const results = await runChecksForAllEnabledDomains(db, {
      ...options,
      concurrency,
    });

    // Retention (M-1) runs once per day. We compare the stored
    // `last_retention` timestamp and the current time.
    try {
      const last = db
        .select()
        .from(schedulerState)
        .where(eq(schedulerState.key, "last_retention"))
        .all()[0];
      const lastTs = last?.value ? Date.parse(last.value) : 0;
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (Date.now() - lastTs > oneDayMs) {
        runRetention(db);
        setSchedulerState(db, "last_retention", new Date().toISOString());
      }
    } catch (err) {
      logger.error({ err }, "retention failed");
    }

    setSchedulerState(db, "last_tick", new Date().toISOString());
    return { ran: results.length };
  } finally {
    releaseSchedulerLock(db);
  }
}

export function startScheduler(
  db: DB = getDb(),
  options: { rejectUnauthorized?: boolean; timeoutMs?: number } = {}
): { task: ScheduledTask; intervalMinutes: number; expression: string } {
  if (task) {
    return {
      task,
      intervalMinutes: getCheckIntervalMinutes(),
      expression: buildCronExpression(getCheckIntervalMinutes()),
    };
  }
  const interval = getCheckIntervalMinutes();
  const expression = buildCronExpression(interval);
  if (!cron.validate(expression)) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }
  task = cron.schedule(expression, () => {
    tickChecks(db, options).catch((err) => {
      logger.error({ err }, "scheduled tick failed");
    });
  });
  return { task, intervalMinutes: interval, expression };
}

export function stopScheduler(): void {
  if (task) {
    task.stop();
    task = null;
  }
}

export function isSchedulerRunning(): boolean {
  return task !== null;
}
