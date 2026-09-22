import { db } from "./db";
import { getSetting, timezone } from "./settings";

export interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

// Local-wall-clock parts in a given IANA timezone.
export function tzParts(tz: string, d: Date = new Date()): TzParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== "literal") parts[p.type] = p.value;
  const year = +parts.year;
  const month = +parts.month;
  const day = +parts.day;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    year,
    month,
    day,
    hour: +parts.hour,
    minute: +parts.minute,
    second: +parts.second,
    weekday,
  };
}

export function dayKeyFromParts(p: TzParts): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function dayKey(tz: string, d: Date = new Date()): string {
  return dayKeyFromParts(tzParts(tz, d));
}

export function monthStartKey(tz: string, d: Date = new Date()): string {
  const p = tzParts(tz, d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-01`;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// Most recent local date whose weekday == resetDay (0=Sun .. 6=Sat).
export function weekStartKey(tz: string, resetDay: number, d: Date = new Date()): string {
  let key = dayKey(tz, d);
  let parts = tzParts(tz, d);
  while (parts.weekday !== resetDay) {
    key = addDays(key, -1);
    parts = tzParts(tz, new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1)));
    // recompute parts from the key directly to avoid drift
    parts = tzPartsOfString(key);
  }
  return key;
}

function tzPartsOfString(day: string): TzParts {
  const [y, m, d] = day.split("-").map(Number);
  return {
    year: y,
    month: m,
    day: d,
    hour: 0,
    minute: 0,
    second: 0,
    weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
  };
}

export function usageWeekResetDay(): number {
  return Math.max(0, Math.min(6, parseInt(getSetting("usage_week_reset_day") || "0", 10) || 0));
}

// ----- Logging -------------------------------------------------------------
export function logUsage(
  keyId: number,
  tokens: number,
  success: boolean,
  tz?: string,
  model?: string
): void {
  const zone = tz ?? timezone();
  const p = tzParts(zone);
  const day = dayKeyFromParts(p);
  const tok = success ? tokens : 0;
  db.prepare(
    `INSERT INTO key_usage_hourly(key_id, model, day, hour, hits, tokens)
     VALUES(?, ?, ?, ?, 1, ?)
     ON CONFLICT(key_id, model, day, hour) DO UPDATE SET
       hits = hits + 1,
       tokens = tokens + excluded.tokens`
  ).run(keyId, model ?? "", day, p.hour, tok);
}

function modelFilter(keyId: number, model?: string): { sql: string; args: unknown[] } {
  if (model !== undefined) return { sql: "key_id = ? AND model = ?", args: [keyId, model ?? ""] };
  return { sql: "key_id = ?", args: [keyId] };
}

// ----- Aggregation ---------------------------------------------------------
export function usageSummary(keyId: number, tz?: string, model?: string) {
  const zone = tz ?? timezone();
  const today = dayKey(zone);
  const wkStart = weekStartKey(zone, usageWeekResetDay());
  const monthStart = monthStartKey(zone);
  const mf = modelFilter(keyId, model);

  const all = db
    .prepare(`SELECT COALESCE(SUM(hits),0) hits, COALESCE(SUM(tokens),0) tokens FROM key_usage_hourly WHERE ${mf.sql}`)
    .get(...mf.args) as { hits: number; tokens: number };

  const daily = db
    .prepare(`SELECT COALESCE(SUM(hits),0) hits, COALESCE(SUM(tokens),0) tokens FROM key_usage_hourly WHERE ${mf.sql} AND day = ?`)
    .get(...mf.args, today) as { hits: number; tokens: number };

  const weekly = db
    .prepare(`SELECT COALESCE(SUM(hits),0) hits FROM key_usage_hourly WHERE ${mf.sql} AND day >= ?`)
    .get(...mf.args, wkStart) as { hits: number };

  const monthly = db
    .prepare(`SELECT COALESCE(SUM(tokens),0) tokens FROM key_usage_hourly WHERE ${mf.sql} AND day >= ?`)
    .get(...mf.args, monthStart) as { tokens: number };

  const busy = db
    .prepare(`SELECT hour, SUM(hits) h FROM key_usage_hourly WHERE ${mf.sql} GROUP BY hour ORDER BY h DESC, hour ASC LIMIT 1`)
    .get(...mf.args) as { hour: number; h: number } | undefined;

  return {
    hitsToday: daily.hits,
    tokensToday: daily.tokens,
    hitsWeek: weekly.hits,
    hitsAll: all.hits,
    tokensAll: all.tokens,
    tokensMonth: monthly.tokens,
    busyHour: busy ? busy.hour : null,
    busyHits: busy ? busy.h : 0,
  };
}

// Tokens "used" for the key's configured period (daily/monthly/total).
export function periodTokensUsed(keyId: number, period: string, tz?: string, model?: string): number {
  const zone = tz ?? timezone();
  const mf = modelFilter(keyId, model);
  if (period === "daily") {
    const r = db
      .prepare(`SELECT COALESCE(SUM(tokens),0) t FROM key_usage_hourly WHERE ${mf.sql} AND day = ?`)
      .get(...mf.args, dayKey(zone)) as { t: number };
    return r.t;
  }
  if (period === "monthly") {
    const r = db
      .prepare(`SELECT COALESCE(SUM(tokens),0) t FROM key_usage_hourly WHERE ${mf.sql} AND day >= ?`)
      .get(...mf.args, monthStartKey(zone)) as { t: number };
    return r.t;
  }
  const r = db
    .prepare(`SELECT COALESCE(SUM(tokens),0) t FROM key_usage_hourly WHERE ${mf.sql}`)
    .get(...mf.args) as { t: number };
  return r.t;
}

// 24 hourly buckets (hits), in local time.
export function usageHours(keyId: number, model?: string): number[] {
  const mf = modelFilter(keyId, model);
  const rows = db
    .prepare(`SELECT hour, SUM(hits) h FROM key_usage_hourly WHERE ${mf.sql} GROUP BY hour`)
    .all(...mf.args) as { hour: number; h: number }[];
  const out = new Array(24).fill(0);
  for (const r of rows) if (r.hour >= 0 && r.hour < 24) out[r.hour] = r.h;
  return out;
}

export function resetUsage(keyId: number, model?: string): number {
  const mf = modelFilter(keyId, model);
  const info = db.prepare(`DELETE FROM key_usage_hourly WHERE ${mf.sql}`).run(...mf.args);
  return info.changes;
}

export interface WeekBucket {
  weekStart: string;
  tokens: number;
  hits: number;
}

export function usageWeeklyHistory(keyId: number, n = 8): WeekBucket[] {
  const zone = timezone();
  const resetDay = usageWeekResetDay();
  const start = weekStartKey(zone, resetDay);
  const starts: string[] = [];
  let cur = start;
  starts.push(cur);
  for (let i = 1; i < n; i++) {
    cur = addDays(cur, -7);
    starts.push(cur);
  }
  return starts
    .map((weekStart) => {
      const next = addDays(weekStart, 7);
      const r = db
        .prepare(`SELECT COALESCE(SUM(tokens),0) tokens, COALESCE(SUM(hits),0) hits FROM key_usage_hourly WHERE key_id = ? AND day >= ? AND day < ?`)
        .get(keyId, weekStart, next) as { tokens: number; hits: number };
      return { weekStart, tokens: r.tokens, hits: r.hits };
    })
    .reverse();
}

export function pruneUsageHistory(beforeDays: number): void {
  const zone = timezone();
  const p = tzParts(zone);
  const cutoff = new Date(Date.UTC(p.year, p.month - 1, p.day - beforeDays));
  const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}-${String(cutoff.getUTCDate()).padStart(2, "0")}`;
  db.prepare(`DELETE FROM key_usage_hourly WHERE day < ?`).run(cutoffKey);
}

// Per-model usage for a key, joined with each model's configured limits.
export function modelUsageList(keyId: number, tz?: string): ModelUsage[] {
  const zone = tz ?? timezone();
  const models = db
    .prepare("SELECT * FROM key_models WHERE key_id = ? ORDER BY id")
    .all(keyId) as {
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
  }[];

  return models.map((m) => {
    const s = usageSummary(keyId, zone, m.model);
    const used = periodTokensUsed(keyId, m.period, zone, m.model);
    const todayTokens = s.tokensToday;
    const limit = m.token_limit || 0;
    const pct = limit > 0 ? Math.min(100, (todayTokens / limit) * 100) : 0;
    const reqPct = m.rpd > 0 ? Math.min(100, (s.hitsToday / m.rpd) * 100) : m.rpd === 0 ? 0 : 100;
    return {
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
    };
  });
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