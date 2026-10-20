import { byId, rows, insertRow, insertMany, updateRow, deleteRows, nowSql } from "./store";
import { decrypt, encrypt } from "./crypto";
import { healthCheck } from "./providers";
import { sendAlert } from "./alerts";
import { getSetting } from "./settings";
import {
  logUsage,
  periodTokensUsed,
  usageSummary,
  usageHours,
  resetUsage,
  modelUsageList,
  usageScope,
  aggregateHourly,
  periodTokensFrom,
  type HourlyRow,
  type KeyModelRow,
} from "./usage";
import { maskKey } from "./crypto";

export interface ApiKeyRow {
  id: number;
  provider: string;
  account_name: string;
  account_email: string;
  api_key_enc: string;
  base_url: string;
  usage_limit: number;
  usage_period: string;
  usage_hour: number;
  provider_usage: number | null;
  provider_limit: number | null;
  disabled: number;
  status: string;
  status_detail: string;
  last_checked_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export async function checkKey(keyId: number): Promise<ApiKeyRow> {
  const key = await byId<ApiKeyRow>("api_keys", keyId);
  if (!key) throw new Error("key not found");

  const plain = decrypt(key.api_key_enc);
  const result = await healthCheck(key.provider, plain, key.base_url || undefined);

  const statusDetail =
    (result.ratelimit && Object.entries(result.ratelimit).length ? JSON.stringify(result.ratelimit) : "") ||
    key.status_detail;

  await insertRow("key_checks", {
    key_id: keyId,
    status: result.status,
    error: result.error || null,
    response_ms: result.responseMs ?? null,
    ratelimit: result.ratelimit && Object.keys(result.ratelimit).length ? JSON.stringify(result.ratelimit) : null,
    provider_usage: result.providerUsage !== null ? String(result.providerUsage) : null,
  });

  const now = nowSql();
  await updateRow("api_keys", keyId, {
    status: result.status,
    status_detail: statusDetail,
    last_error: result.error || "",
    last_checked_at: now,
    provider_usage: result.providerUsage !== null ? result.providerUsage : key.provider_usage,
    provider_limit: result.providerLimit !== null ? result.providerLimit : key.provider_limit,
    updated_at: now,
  });

  // Alert only on a fresh death (previous status was not dead/unknown-missed).
  if (
    result.status === "dead" &&
    key.status !== "dead" &&
    (await getSetting("alert_on_key_dead")) !== "0"
  ) {
    void sendAlert({
      kind: "key_dead",
      title: `API key died — ${key.account_name}`,
      lines: [`Provider: ${key.provider}`, `Error: ${result.error || "unknown"}`, `Checked at: ${now}`],
    });
  }

  return (await byId<ApiKeyRow>("api_keys", keyId))!;
}

export async function checkAllKeys(): Promise<{ ok: number; failed: number }> {
  const keys = await rows<ApiKeyRow>("api_keys", { disabled: 0 }, { order: "id" });
  let ok = 0;
  let failed = 0;
  for (const k of keys) {
    try {
      await checkKey(k.id);
      ok++;
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}

// ----- Enrichment for the UI ------------------------------------------------
export async function withUsage(key: ApiKeyRow, tz: string): Promise<Record<string, any>> {
  const summary = await usageSummary(key.id, tz);
  const used = await periodTokensUsed(key.id, key.usage_period, tz);
  let plain = "";
  try {
    plain = decrypt(key.api_key_enc);
  } catch {
    plain = "";
  }
  const mask = plain ? `${plain.slice(0, 4)}…${plain.slice(-4)}` : "";
  const limit = key.provider_limit ?? key.usage_limit ?? 0;
  const primaryLimit = limit;
  const primaryUsed =
    key.provider_usage !== null ? key.provider_usage : used;
  const pct = primaryLimit > 0 ? Math.min(100, (primaryUsed / primaryLimit) * 100) : 0;
  return {
    ...key,
    masked_key: mask,
    usage: {
      ...summary,
      used,
      limit: key.usage_limit,
      provider_usage: key.provider_usage,
      provider_limit: key.provider_limit,
      primaryUsed,
      primaryLimit,
      pct: Math.round(pct * 10) / 10,
      limitLeft: Math.max(0, primaryLimit - primaryUsed),
      hours: summary.busyHour,
    },
    lastCheck: key.last_checked_at,
    models: await modelUsageList(key.id, tz),
  };
}

export async function listKeys(): Promise<ApiKeyRow[]> {
  return rows<ApiKeyRow>("api_keys", {}, { order: "id" });
}

/**
 * Load every key with its usage + per-model usage in THREE queries total.
 *
 * The per-key `withUsage` path re-fetches the whole `key_usage_hourly` slice for
 * a key once for the summary, again for the period total, and twice more per
 * model — ~20 full fetches for a Groq key with 8 models, all sequential, which
 * made the Keys page take 15s+. Here everything is fetched once and aggregated
 * in memory.
 */
export async function listKeysWithUsage(tz: string): Promise<Record<string, any>[]> {
  const scope = await usageScope(tz);
  const [allKeys, allUsage, allModels] = await Promise.all([
    rows<ApiKeyRow>("api_keys", {}, { order: "id" }),
    rows<HourlyRow>("key_usage_hourly", {}),
    rows<KeyModelRow>("key_models", {}, { order: "id" }),
  ]);

  const usageByKey = new Map<number, HourlyRow[]>();
  for (const r of allUsage) {
    const bucket = usageByKey.get(r.key_id);
    if (bucket) bucket.push(r);
    else usageByKey.set(r.key_id, [r]);
  }
  const modelsByKey = new Map<number, KeyModelRow[]>();
  for (const m of allModels) {
    const bucket = modelsByKey.get(m.key_id);
    if (bucket) bucket.push(m);
    else modelsByKey.set(m.key_id, [m]);
  }

  const out: Record<string, any>[] = [];
  for (const k of allKeys) {
    const keyRows = usageByKey.get(k.id) ?? [];
    const summary = aggregateHourly(keyRows, scope);
    const used = periodTokensFrom(keyRows, k.usage_period, scope);

    const models = (modelsByKey.get(k.id) ?? []).map((m) => {
      const per = keyRows.filter((r) => r.model === m.model);
      const s = aggregateHourly(per, scope);
      const usedM = periodTokensFrom(per, m.period, scope);
      const limit = m.token_limit || 0;
      const pct = limit > 0 ? Math.min(100, (s.tokensToday / limit) * 100) : 0;
      const reqPct = m.rpd > 0 ? Math.min(100, (s.hitsToday / m.rpd) * 100) : m.rpd === 0 ? 0 : 100;
      return {
        id: m.id,
        keyId: k.id,
        model: m.model,
        tokenLimit: m.token_limit,
        period: m.period,
        usage_hour: m.usage_hour,
        rpm: m.rpm,
        rpd: m.rpd,
        tpm: m.tpm,
        enabled: m.enabled,
        used: usedM,
        tokensToday: s.tokensToday,
        hitsToday: s.hitsToday,
        hitsAll: s.hitsAll,
        busyHour: s.busyHour,
        pct: Math.round(pct * 10) / 10,
        limitLeft: Math.max(0, limit - s.tokensToday),
        reqPct: reqPct === 100 && m.rpd > 0 && s.hitsToday < m.rpd ? 99.9 : Math.round(reqPct * 10) / 10,
        reqLeft: Math.max(0, m.rpd - s.hitsToday),
      };
    });

    let plain = "";
    try {
      plain = decrypt(k.api_key_enc);
    } catch {
      plain = "";
    }

    const limit = k.provider_limit ?? k.usage_limit ?? 0;
    const primaryUsed = k.provider_usage !== null ? k.provider_usage : used;
    const pct = limit > 0 ? Math.min(100, (primaryUsed / limit) * 100) : 0;

    const { api_key_enc: _drop, ...rest } = k as Record<string, any>;
    out.push({
      ...rest,
      provider_mask: maskKey(plain),
      masked_key: maskKey(plain),
      lastCheck: k.last_checked_at,
      models,
      usage: {
        ...summary,
        used,
        limit: k.usage_limit,
        provider_usage: k.provider_usage,
        provider_limit: k.provider_limit,
        primaryUsed,
        primaryLimit: limit,
        pct: Math.round(pct * 10) / 10,
        limitLeft: Math.max(0, limit - primaryUsed),
        hours: summary.busyHour,
      },
    });
  }
  return out;
}

const VALID_PROVIDERS = ["openrouter", "cerebras", "groq", "xai", "openai", "gemini", "other"];

function safeStr(v: unknown, max = 500): string {
  return String(v ?? "").slice(0, max);
}

function safeNum(v: unknown, def = 0): number {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : def;
}

// One entry of a multi-key submission. A key row always belongs to a single
// account, so adding N keys under one provider means N api_keys rows that share
// the provider / base URL / limits / model list.
export interface KeyEntryInput {
  apiKey: string;
  accountName: string;
}

// Normalise the body into a list of key entries. Accepts either the classic
// single `apiKey` field or the multi-key `apiKeys: [{ key, name }]` array.
// Returns [] when nothing usable was supplied, so the caller can reject it.
function keyEntriesFrom(body: Record<string, unknown>): KeyEntryInput[] {
  if (Array.isArray(body.apiKeys)) {
    const entries = (body.apiKeys as unknown[]).map((raw) => {
      const e = (raw ?? {}) as Record<string, unknown>;
      return {
        apiKey: safeStr(e.apiKey ?? e.key, 2000),
        accountName: safeStr(e.accountName ?? e.name, 200),
      };
    });
    // `apiKeys` was supplied — honour it as-is instead of silently falling back
    // to the single-key field (which could mint a blank key row).
    return entries.filter((e) => e.apiKey);
  }
  const single = {
    apiKey: safeStr(body.apiKey, 2000),
    accountName: safeStr(body.accountName, 200),
  };
  return single.apiKey ? [single] : [];
}

// Shared create logic used by POST /api/keys and POST /api/ai/ollama.
// Creates ONE row per submitted key; returns every id it created.
export async function createKeyRows(body: Record<string, unknown>): Promise<{ ids: number[] }> {
  const provider = safeStr(body.provider) || "other";
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new Error("invalid provider");
  }
  const sharedName = safeStr(body.accountName, 200);
  const entries = keyEntriesFrom(body);
  if (!entries.length) {
    throw new Error("at least one API key is required");
  }
  if (!sharedName && entries.some((e) => !e.accountName)) {
    throw new Error("accountName is required (set it once at the top, or on every key)");
  }

  const usageLimit = Math.max(0, safeNum(body.usageLimit));
  const usagePeriod = ["daily", "monthly", "total"].includes(String(body.usagePeriod)) ? String(body.usagePeriod) : "monthly";
  const usageHour = Math.max(0, Math.min(23, Math.round(safeNum(body.usageHour, 9))));
  const baseUrl = safeStr(body.baseUrl, 500);
  const models = Array.isArray(body.models) ? body.models : null;

  const ids: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // Per-key name wins; otherwise fall back to the shared name, auto-suffixed
    // (2, 3, …) when several keys share it so rows stay distinguishable.
    const base = e.accountName || sharedName;
    const accountName =
      !e.accountName && sharedName && entries.length > 1 && i > 0 ? `${sharedName} ${i + 1}` : base;
    const inserted = await insertRow<ApiKeyRow>("api_keys", {
      provider,
      account_name: accountName,
      account_email: safeStr(body.accountEmail, 300),
      api_key_enc: encrypt(e.apiKey),
      base_url: baseUrl,
      usage_limit: usageLimit,
      usage_period: usagePeriod,
      usage_hour: usageHour,
    });
    const keyId = Number(inserted.id);
    if (models) await saveKeyModels(keyId, models);
    ids.push(keyId);
  }
  return { ids };
}

export async function createKeyRow(body: Record<string, unknown>): Promise<{ id: number }> {
  const { ids } = await createKeyRows(body);
  return { id: ids[0] };
}

export async function logKeyUsage(keyId: number, tokens: number, success: boolean, model?: string): Promise<void> {
  await logUsage(keyId, tokens, success, (await getSetting("timezone")) || "Asia/Dhaka", model);
}

export async function keyUsageSummary(keyId: number) {
  return usageSummary(keyId);
}

export async function keyUsageHours(keyId: number): Promise<number[]> {
  return usageHours(keyId);
}

export async function resetKeyUsage(keyId: number): Promise<void> {
  return resetUsage(keyId);
}

// Replace the model list for a key (each model tracks its own free-token limits).
export async function saveKeyModels(keyId: number, models: unknown[]): Promise<void> {
  await deleteRows("key_models", { key_id: keyId });
  const rowsData: Record<string, unknown>[] = [];
  for (const raw of models ?? []) {
    const m = raw as Record<string, unknown>;
    const model = String(m.model ?? "").trim().slice(0, 200);
    if (!model) continue;
    const num = (...vs: unknown[]): number => {
      for (const v of vs) {
        const n = parseFloat(String(v ?? ""));
        if (Number.isFinite(n) && n >= 0) return Math.round(n);
      }
      return 0;
    };
    rowsData.push({
      key_id: keyId,
      model,
      token_limit: num(m.tokenLimit, m.tpd, m.tokensPerDay),
      period: ["daily", "weekly", "monthly", "total"].includes(String(m.period)) ? String(m.period) : "daily",
      usage_hour: Math.max(0, Math.min(23, num(m.usageHour, m.usage_hour))),
      rpm: num(m.rpm, m.requestsPerMinute),
      rpd: num(m.rpd, m.requestsPerDay),
      tpm: num(m.tpm, m.tokensPerMinute),
      enabled: m.enabled === false ? 0 : 1,
    });
  }
  if (rowsData.length) await insertMany("key_models", rowsData);
}

export { periodTokensUsed, usageSummary };