export async function register() {
  // Never run background jobs while `next build` is generating pages, and
  // never start them twice (dev re-runs register on hot reloads).
  const g = globalThis as { __tamSchedulerStarted?: boolean };
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build" && !g.__tamSchedulerStarted) {
    g.__tamSchedulerStarted = true;
    const { startScheduler } = await import("./lib/scheduler");
    await startScheduler().catch(() => {
      /* scheduler startup must never crash lambda init */
    });
  }
}