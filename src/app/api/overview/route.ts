import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { rows } from "@/lib/store";
import { timezone } from "@/lib/settings";
import { activeAlerts } from "@/lib/alerts";
import { kaggleOverview, getAccount, gpuRemainingHours, watchKaggle, runAutoSwitcher } from "@/lib/kaggle";
import { PROVIDERS } from "@/lib/providers";

export async function GET() {
  const g = await guard();
  if (g) return g;
  const zone = await timezone();

  const keyRows = await rows<any>("api_keys", { disabled: 0 });
  const total = keyRows.length;
  const alive = keyRows.filter((k) => k.status === "alive").length;
  const dead = keyRows.filter((k) => k.status === "dead").length;
  const rateLimited = keyRows.filter((k) => k.status === "rate_limited").length;
  const unknown = keyRows.filter((k) => ["unknown", "queued"].includes(k.status)).length;

  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
  const todayKey = `${today.year}-${today.month}-${today.day}`;

  const usageRows = await rows<{ tokens: number }>("key_usage_hourly", { day: todayKey });
  const tokensToday = usageRows.reduce((s, r) => s + (r.tokens ?? 0), 0);

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

  const kaggle = await kaggleOverview();

  const accountRows = await rows<any>("kaggle_accounts", { disabled: 0 });
  const accounts = [];
  for (const a of accountRows) {
    const account = await getAccount(a.id);
    if (!account) continue;
    accounts.push({
      id: a.id,
      label: a.label,
      username: a.username,
      remaining: await gpuRemainingHours(account),
    });
  }

  // Sniff fresh status as the dashboard loads so it is never stale.
  void watchKaggle().catch(() => {});
  void runAutoSwitcher().catch(() => {});

  return NextResponse.json({
    providerOptions: PROVIDERS.map((p) => ({ id: p.id, label: p.label, color: p.color })),
    keys: { total, alive, dead, rateLimited, unknown, tokensToday, deadKeys },
    kaggle,
    accounts,
    alerts: await activeAlerts(),
    timezone: zone,
    lastUpdated: new Date().toISOString(),
  });
}