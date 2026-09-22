import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { timezone } from "@/lib/settings";
import { activeAlerts } from "@/lib/alerts";
import { kaggleOverview, runAutoSwitcher, watchKaggle, getAccount, gpuRemainingHours } from "@/lib/kaggle";
import { PROVIDERS } from "@/lib/providers";

function todayInTz(zone: string): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date())) if (p.type !== "literal") parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function GET() {
  const g = await guard();
  if (g) return g;
  const zone = timezone();

  const keyRows = db.prepare("SELECT * FROM api_keys WHERE disabled = 0").all() as any[];
  const total = keyRows.length;
  const alive = keyRows.filter((k) => k.status === "alive").length;
  const dead = keyRows.filter((k) => k.status === "dead").length;
  const rateLimited = keyRows.filter((k) => k.status === "rate_limited").length;
  const unknown = keyRows.filter((k) => ["unknown", "queued"].includes(k.status)).length;

  const todayRow = db
    .prepare(`SELECT COALESCE(SUM(tokens),0) t FROM key_usage_hourly WHERE day = ?`)
    .get(todayInTz(zone)) as { t: number };

  const deadKeys = keyRows
    .filter((k) => k.status === "dead")
    .map((k) => ({
      id: k.id,
      provider: k.provider,
      account_name: k.account_name,
      last_error: k.last_error,
      last_checked_at: k.last_checked_at,
    }))
    .slice(0, 8);

  const kaggle = kaggleOverview();

  const accounts = (db.prepare("SELECT * FROM kaggle_accounts WHERE disabled = 0").all() as any[]).map(
    (a) => {
      const account = getAccount(a.id)!;
      return { id: a.id, label: a.label, username: a.username, remaining: gpuRemainingHours(account) };
    }
  );

  // Sniff fresh status as the dashboard loads so it is never stale.
  void watchKaggle().catch(() => {});
  void runAutoSwitcher().catch(() => {});

  return NextResponse.json({
    providerOptions: PROVIDERS.map((p) => ({ id: p.id, label: p.label, color: p.color })),
    keys: { total, alive, dead, rateLimited, unknown, tokensToday: todayRow.t, deadKeys },
    kaggle,
    accounts,
    alerts: activeAlerts(),
    timezone: zone,
    lastUpdated: new Date().toISOString(),
  });
}