import cron, { type ScheduledTask } from "node-cron";
import { runChecksForAllEnabledDomains } from "./checker-runner.js";

let task: ScheduledTask | null = null;
let running = false;

export function getCheckIntervalMinutes(): number {
  const raw = process.env.CHECK_INTERVAL;
  if (!raw) return 60;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return 60;
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

export async function tickChecks(): Promise<{ ran: number }> {
  if (running) return { ran: 0 };
  running = true;
  try {
    const results = await runChecksForAllEnabledDomains();
    return { ran: results.length };
  } finally {
    running = false;
  }
}

export function startScheduler(): { task: ScheduledTask; intervalMinutes: number; expression: string } {
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
    tickChecks().catch((err) => {
      console.error("[scheduler] tick failed:", err);
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
