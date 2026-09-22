import {
  rows,
  row,
  deleteRows,
  upsertRows,
  addDays,
  dayKey,
  dayKeyFromParts,
  monthStartKey,
  tzParts,
  weekStartKey,
  type Where,
  type TzParts,
} from "./store";
import { getSetting, timezone } from "./settings";

export { tzParts, dayKey, dayKeyFromParts, monthStartKey, weekStartKey, addDays, type TzParts };

type HourlyRow = {
  key_id: number;
  model: string;
  day: string;
  hour: number;
  hits: number;
  tokens: number;
};

export async function usageWeekResetDay(): Promise<number> {
  return Math.max(0, Math.min(6, parseInt((await getSetting("usage_week_reset_day")) || "0", 10) || 0));
}

// ----- Logging -------------------------------------------------------------
export async function logUsage(
  keyId: number,
  tokens: number,
  success: boolean,
  tz?: string,
  model?: string
): Promise<void> {
  const zone = tz ?? (await timezone());
  const p = tzParts(zone);
  const day = dayKeyFromParts(p);
  const tok = success ? tokens : 0;
  const prev = (await row<HourlyRow>("key_usage_hourly", {
    key_id: keyId,
    model: model ?? "",
    day,
    hour: p.hour,
  })) as HourlyRow | null;
  await upsertRows(
    "key_usage_hourly",
    [
      {
        key_id: keyId,
        model: model ?? "",
        day,
        hour: p.hour,
        hits: (prev?.hits ?? 0) + 1,
        tokens: (prev?.tokens ?? 0) + tok,
      },
    ],
    "key_id,model,day,hour"
  );
}

function hourFilters(keyId: number, model?: string): Where {
  const f: Where = { key_id: keyId };
  if (model !== undefined) f.model = model || "";
  return f;
}

// ----- Aggregation ---------------------------------------------------------
export async function usageSummary(keyId: number, tz?: string, model?: string) {
  const zone = tz ?? (await timezone());
  const today = dayKey(zone);
  const wkStart = weekStartKey(zone, await usageWeekResetDay());
  const monthStart = monthStartKey(zone);
  const mf = hourFilters(keyId, model);

  const all = await rows<HourlyRow>("key_usage_hourly", mf);
  let hitsAll = 0;
  let tokensAll = 0;
  let hitsToday = 0;
  let tokensToday = 0;
  let hitsWeek = 0;
  let tokensMonth = 0;
  const byHour = new Map<number, number>();
  for (const r of all) {
    hitsAll += r.hits ?? 0;
    tokensAll += r.tokens ?? 0;
    if (r.day === today) {
      hitsToday += r.hits ?? 0;
      tokensToday += r.tokens ?? 0;
    }
    if (r.day >= wkStart) hitsWeek += r.hits ?? 0;
    if (r.day >= monthStart) tokensMonth += r.tokens ?? 0;
    byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + (r.hits ?? 0));
  }
  let busyHour: number | null = null;
  let busyHits = 0;
  for (const [h, n] of byHour) {
    if (n > busyHits) {
      busyHits = n;
      busyHour = h;
    }
  }

  return {
    hitsToday,
    tokensToday,
    hitsWeek,
    hitsAll,
    tokensAll,
    tokensMonth,
    busyHour,
    busyHits,
  };
}

// Tokens "used" for the key's configured period (daily/monthly/total).
export async function periodTokensUsed(keyId: number, period: string, tz?: string, model?: string): Promise<number> {
  const zone = tz ?? (await timezone());
  const mf = hourFilters(keyId, model);
  const all = await rows<HourlyRow>("key_usage_hourly", mf);
  if (period === "daily") {
    const day = dayKey(zone);
    return all.filter((r) => r.day === day).reduce((s, r) => s + (r.tokens ?? 0), 0);
  }
  if (period === "monthly") {
    const start = monthStartKey(zone);
    return all.filter((r) => r.day >= start).reduce((s, r) => s + (r.tokens ?? 0), 0);
  }
  return all.reduce((s, r) => s + (r.tokens ?? 0), 0);
}

// 24 hourly buckets (hits), in local time.
export async function usageHours(keyId: number, model?: string): Promise<number[]> {
  const mf = hourFilters(keyId, model);
  const all = await rows<HourlyRow>("key_usage_hourly", mf);
  const out = new Array(24).fill(0);
  for (const r of all) if (r.hour >= 0 && r.hour < 24) out[r.hour] += r.hits ?? 0;
  return out;
}

export async function resetUsage(keyId: number, model?: string): Promise<void> {
  await deleteRows("key_usage_hourly", hourFilters(keyId, model));
}

export interface WeekBucket {
  weekStart: string;
  tokens: number;
  hits: number;
}

export async function usageWeeklyHistory(keyId: number, n = 8): Promise<WeekBucket[]> {
  const zone = await timezone();
  const resetDay = await usageWeekResetDay();
  const start = weekStartKey(zone, resetDay);
  const starts: string[] = [];
  let cur = start;
  starts.push(cur);
  for (let i = 1; i < n; i++) {
    cur = addDays(cur, -7);
    starts.push(cur);
  }
  const all = await rows<HourlyRow>("key_usage_hourly", { key_id: keyId });
  return starts
    .map((weekStart) => {
      const next = addDays(weekStart, 7);
      const inWeek = all.filter((r) => r.day >= weekStart && r.day < next);
      return {
        weekStart,
        tokens: inWeek.reduce((s, r) => s + (r.tokens ?? 0), 0),
        hits: inWeek.reduce((s, r) => s + (r.hits ?? 0), 0),
      };
    })
    .reverse();
}

export async function pruneUsageHistory(beforeDays: number): Promise<void> {
  const zone = await timezone();
  const p = tzParts(zone);
  const cutoff = new Date(Date.UTC(p.year, p.month - 1, p.day - beforeDays));
  const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}-${String(cutoff.getUTCDate()).padStart(2, "0")}`;
  await deleteRows("key_usage_hourly", { day: { lt: cutoffKey } });
}

export interface KeyModelRow {
  id: number;
  key_id: number;
  model: string;
  token_limit: number;
  period: string;
  usage_hour: number;
  rpm: number;
  rpd: number;
  tpm: number;
  enabled: number;
}

export interface ModelUsage {
  id: number;
  keyId: number;
  model: string;
  tokenLimit: number;
  period: string;
  usage_hour: number;
  rpm: number;
  rpd: number;
  tpm: number;
  enabled: number;
  used: number;
  tokensToday: number;
  hitsToday: number;
  hitsAll: number;
  busyHour: number | null;
  pct: number;
  limitLeft: number;
  reqPct: number;
  reqLeft: number;
}

// Per-model usage for a key, joined with each model's configured limits.
export async function modelUsageList(keyId: number, tz?: string): Promise<ModelUsage[]> {
  const zone = tz ?? (await timezone());
  const models = await rows<KeyModelRow>("key_models", { key_id: keyId }, { order: "id" });

  const out: ModelUsage[] = [];
  for (const m of models) {
    const s = await usageSummary(keyId, zone, m.model);
    const used = await periodTokensUsed(keyId, m.period, zone, m.model);
    const todayTokens = s.tokensToday;
    const limit = m.token_limit || 0;
    const pct = limit > 0 ? Math.min(100, (todayTokens / limit) * 100) : 0;
    const reqPct = m.rpd > 0 ? Math.min(100, (s.hitsToday / m.rpd) * 100) : m.rpd === 0 ? 0 : 100;
    out.push({
      id: m.id,
      keyId,
      model: m.model,
      tokenLimit: m.token_limit,
      period: m.period,
      usage_hour: m.usage_hour,
      rpm: m.rpm,
      rpd: m.rpd,
      tpm: m.tpm,
      enabled: m.enabled,
      used,
      tokensToday: todayTokens,
      hitsToday: s.hitsToday,
      hitsAll: s.hitsAll,
      busyHour: s.busyHour,
      pct: Math.round(pct * 10) / 10,
      limitLeft: Math.max(0, limit - todayTokens),
      reqPct: reqPct === 100 && m.rpd > 0 && s.hitsToday < m.rpd ? 99.9 : Math.round(reqPct * 10) / 10,
      reqLeft: Math.max(0, m.rpd - s.hitsToday),
    });
  }
  return out;
}