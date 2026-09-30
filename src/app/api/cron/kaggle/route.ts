import { NextResponse } from "next/server";
import { refreshAllQuotas, watchKaggle, runAutoSwitcher } from "@/lib/kaggle";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Background trigger for the Kaggle watcher/auto-switcher. Called by the GitHub
// Actions scheduled workflow (.github/workflows/kaggle-watch.yml) or by any
// uptime pinger. Guarded by a bearer token (CRON_SECRET, falling back to
// USAGE_LOG_BEARER) so it cannot be abused; rejected outright if neither env
// var is configured on the host.
export async function GET(req: Request) {
  const allowed = [process.env.CRON_SECRET, process.env.USAGE_LOG_BEARER].filter(Boolean) as string[];
  const auth = req.headers.get("authorization") || "";
  const headerSecret = req.headers.get("x-cron-secret") || "";
  const ok = allowed.length > 0 && allowed.some((s) => auth === `Bearer ${s}` || headerSecret === s);
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await refreshAllQuotas().catch(() => {});
  await watchKaggle().catch(() => {});
  await runAutoSwitcher().catch(() => {});
  return NextResponse.json({ ok: true });
}