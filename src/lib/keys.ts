import { byId, rows, insertRow, insertMany, updateRow, deleteRows, nowSql } from "./store";
import { decrypt, encrypt } from "./crypto";
import { healthCheck } from "./providers";
import { sendAlert } from "./alerts";
import { getSetting } from "./settings";
import { logUsage, periodTokensUsed, usageSummary, usageHours, resetUsage, modelUsageList } from "./usage";

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

const VALID_PROVIDERS = ["openrouter", "cerebras", "groq", "xai", "openai", "gemini", "other"];

function safeStr(v: unknown, max = 500): string {
  return String(v ?? "").slice(0, max);
}

function safeNum(v: unknown, def = 0): number {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : def;
}

// Shared create logic used by POST /api/keys and POST /api/ai/ollama.
export async function createKeyRow(body: Record<string, unknown>): Promise<{ id: number }> {
  const provider = safeStr(body.provider) || "other";
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new Error("invalid provider");
  }
  const accountName = safeStr(body.accountName, 200);
  const apiKey = safeStr(body.apiKey, 2000);
  if (!accountName || !apiKey) {
    throw new Error("accountName and apiKey are required");
  }
  const usageLimit = Math.max(0, safeNum(body.usageLimit));
  const usagePeriod = ["daily", "monthly", "total"].includes(String(body.usagePeriod)) ? String(body.usagePeriod) : "monthly";
  const usageHour = Math.max(0, Math.min(23, Math.round(safeNum(body.usageHour, 9))));
  const baseUrl = safeStr(body.baseUrl, 500);
  const inserted = await insertRow<ApiKeyRow>("api_keys", {
    provider,
    account_name: accountName,
    account_email: safeStr(body.accountEmail, 300),
    api_key_enc: encrypt(body.apiKey as string),
    base_url: baseUrl,
    usage_limit: usageLimit,
    usage_period: usagePeriod,
    usage_hour: usageHour,
  });
  const keyId = Number(inserted.id);
  if (Array.isArray(body.models)) await saveKeyModels(keyId, body.models);
  return { id: keyId };
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