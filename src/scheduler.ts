import cron from "node-cron";
import type { ShopifyMonitorAgent } from "./agent.js";
import { handleDailyScan } from "./handlers/daily-scan.js";

let scheduledTask: cron.ScheduledTask | null = null;

/**
 * Initialize the cron scheduler for daily translation scans.
 * Uses SCAN_CRON env var, defaults to "0 6 * * *" (6 AM daily).
 */
export function initScheduler(agent: ShopifyMonitorAgent): void {
  const cronExpression = process.env.SCAN_CRON ?? "0 6 * * *";

  if (!cron.validate(cronExpression)) {
    console.error(`[scheduler] Invalid cron expression: ${cronExpression} — using default "0 6 * * *"`);
    return initSchedulerWithExpression(agent, "0 6 * * *");
  }

  initSchedulerWithExpression(agent, cronExpression);
}

function initSchedulerWithExpression(agent: ShopifyMonitorAgent, cronExpression: string): void {
  scheduledTask = cron.schedule(cronExpression, async () => {
    console.log(`[scheduler] Triggering daily translation scan at ${new Date().toISOString()}`);
    try {
      const stats = await handleDailyScan(agent);
      console.log(`[scheduler] Daily scan complete:`, stats);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Daily scan failed: ${errMsg}`);
    }
  }, {
    timezone: "Europe/Brussels",
  });

  // Calculate and log next run time
  const nextRun = getNextCronRun(cronExpression);
  console.log(`[scheduler] Daily scan scheduled with cron "${cronExpression}"`);
  console.log(`[scheduler] Next scheduled run: ${nextRun}`);
}

/**
 * Stop the cron scheduler for graceful shutdown.
 */
export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[scheduler] Cron scheduler stopped");
  }
}

/**
 * Estimate the next run time for a cron expression.
 * Simple heuristic for logging — parses hour and minute from common daily patterns.
 */
function getNextCronRun(expression: string): string {
  const parts = expression.split(" ");
  if (parts.length < 5) return "unknown";

  const minute = parseInt(parts[0], 10);
  const hour = parseInt(parts[1], 10);

  if (isNaN(minute) || isNaN(hour)) return "unknown (complex expression)";

  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  // If today's run time has already passed, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.toISOString();
}
