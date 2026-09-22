import cron, { ScheduledTask } from "node-cron";
import { db } from "./db";
import { getSetting, timezone } from "./settings";
import { checkAllKeys } from "./keys";
import { watchKaggle, runAutoSwitcher, refreshAllQuotas } from "./kaggle";
import { pruneUsageHistory } from "./usage";

// One scheduler per process — instrumentation can re-register on HMR in dev.
declare global {
  // eslint-disable-next-line no-var
  var __tamSchedulerStarted: boolean | undefined;
}

type TaskRef = { job: ScheduledTask; tag: string }[];

const tasks: TaskRef = [];

function minutesToCron(minutes: number): string {
  if (minutes <= 0) minutes = 1;
  if (minutes < 60) return `*/${minutes} * * * *`;
  const h = Math.floor(minutes / 60);
  return `0 */${h} * * *`;
}

function startJob(tag: string, expr: string, fn: () => Promise<void> | void) {
  const existing = tasks.findIndex((t) => t.tag === tag);
  if (existing >= 0) {
    tasks[existing].job.stop();
    tasks.splice(existing, 1);
  }
  const job = cron.schedule(
    expr,
    () => {
      Promise.resolve(fn()).catch(() => {
        /* a failing job must never crash the checker */
      });
    },
    { noOverlap: true, suppressMissedWarning: true, timezone: timezone() || undefined }
  );
  tasks.push({ job, tag });
}

export function startScheduler(): void {
  if (globalThis.__tamSchedulerStarted) return;
  globalThis.__tamSchedulerStarted = true;

  const checkMinutes = parseInt(getSetting("check_interval_minutes") || "10", 10) || 10;
  const pollMinutes = parseInt(getSetting("kaggle_poll_minutes") || "3", 10) || 3;

  startJob("keys", minutesToCron(checkMinutes), async () => {
    await checkAllKeys();
  });
  startJob("kaggle", minutesToCron(pollMinutes), async () => {
    await refreshAllQuotas();
    await watchKaggle();
    await runAutoSwitcher();
  });
  startJob("cleanup", "30 0 * * *", async () => {
    pruneUsageHistory(60);
    db.prepare("DELETE FROM kaggle_session_events WHERE at < datetime('now', '-90 days')").run();
    db.prepare("DELETE FROM key_checks WHERE check_at < datetime('now', '-60 days')").run();
    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  });

  // Kick off once shortly after boot so the UI shows fresh data immediately.
  setTimeout(() => void checkAllKeys().catch(() => {}), 5000);
  setTimeout(() => {
    void refreshAllQuotas()
      .catch(() => {})
      .then(() => watchKaggle())
      .catch(() => {})
      .then(() => runAutoSwitcher())
      .catch(() => {});
  }, 8000);
}

export function restartSchedulerJobs(): void {
  if (!globalThis.__tamSchedulerStarted) return startScheduler();
  const checkMinutes = parseInt(getSetting("check_interval_minutes") || "10", 10) || 10;
  const pollMinutes = parseInt(getSetting("kaggle_poll_minutes") || "3", 10) || 3;
  startJob("keys", minutesToCron(checkMinutes), async () => {
    await checkAllKeys();
  });
  startJob("kaggle", minutesToCron(pollMinutes), async () => {
    await refreshAllQuotas();
    await watchKaggle();
    await runAutoSwitcher();
  });
}