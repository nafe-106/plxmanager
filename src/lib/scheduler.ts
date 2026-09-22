import cron, { ScheduledTask } from "node-cron";
import { deleteRows } from "./store";
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

function startJob(tag: string, expr: string, tz: string, fn: () => Promise<void> | void) {
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
    { noOverlap: true, suppressMissedWarning: true, timezone: tz || undefined }
  );
  tasks.push({ job, tag });
}

async function keysJob(): Promise<void> {
  await checkAllKeys();
}

async function kaggleJob(): Promise<void> {
  await refreshAllQuotas();
  await watchKaggle();
  await runAutoSwitcher();
}

async function cleanupJob(): Promise<void> {
  await pruneUsageHistory(60);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400e3).toISOString();
  await deleteRows("kaggle_session_events", { at: { lt: daysAgo(90) } });
  await deleteRows("key_checks", { check_at: { lt: daysAgo(60) } });
}

export async function startScheduler(): Promise<void> {
  if (globalThis.__tamSchedulerStarted) return;
  globalThis.__tamSchedulerStarted = true;

  const [checkMinutesRaw, pollMinutesRaw, tz] = await Promise.all([
    getSetting("check_interval_minutes"),
    getSetting("kaggle_poll_minutes"),
    timezone(),
  ]);
  const checkMinutes = parseInt(checkMinutesRaw || "10", 10) || 10;
  const pollMinutes = parseInt(pollMinutesRaw || "3", 10) || 3;

  startJob("keys", minutesToCron(checkMinutes), tz, keysJob);
  startJob("kaggle", minutesToCron(pollMinutes), tz, kaggleJob);
  startJob("cleanup", "30 0 * * *", tz, cleanupJob);

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

export async function restartSchedulerJobs(): Promise<void> {
  if (!globalThis.__tamSchedulerStarted) return startScheduler();
  const [checkMinutesRaw, pollMinutesRaw, tz] = await Promise.all([
    getSetting("check_interval_minutes"),
    getSetting("kaggle_poll_minutes"),
    timezone(),
  ]);
  const checkMinutes = parseInt(checkMinutesRaw || "10", 10) || 10;
  const pollMinutes = parseInt(pollMinutesRaw || "3", 10) || 3;
  startJob("keys", minutesToCron(checkMinutes), tz, keysJob);
  startJob("kaggle", minutesToCron(pollMinutes), tz, kaggleJob);
}