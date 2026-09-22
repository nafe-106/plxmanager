import { db, nowSql } from "./db";
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
  const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyId) as ApiKeyRow;
  if (!key) throw new Error("key not found");

  const plain = decrypt(key.api_key_enc);
  const result = await healthCheck(key.provider, plain, key.base_url || undefined);

  const statusDetail =
    (result.ratelimit && Object.entries(result.ratelimit).length ? JSON.stringify(result.ratelimit) : "") ||
    key.status_detail;

  db.prepare(
    `INSERT INTO key_checks(key_id, status, error, response_ms, ratelimit, provider_usage)
     VALUES(?, ?, ?, ?, ?, ?)`
  ).run(
    keyId,
    result.status,
    result.error || null,
    result.responseMs ?? null,
    result.ratelimit && Object.keys(result.ratelimit).length ? JSON.stringify(result.ratelimit) : null,
    result.providerUsage !== null ? String(result.providerUsage) : null
  );

  db.prepare(
    `UPDATE api_keys SET
      status = ?, status_detail = ?, last_error = ?, last_checked_at = ?,
      provider_usage = COALESCE(?, provider_usage),
      provider_limit = COALESCE(?, provider_limit),
      updated_at = ?
      WHERE id = ?`
  ).run(
    result.status,
    statusDetail,
    result.error || "",
    nowSql(),
    result.providerUsage ?? null,
    result.providerLimit ?? null,
    nowSql(),
    keyId
  );

  // Alert only on a fresh death (previous status was not dead/unknown-missed).
  if (
    result.status === "dead" &&
    key.status !== "dead" &&
    getSetting("alert_on_key_dead") !== "0"
  ) {
    void sendAlert({
      kind: "key_dead",
      title: `API key died — ${key.account_name}`,
      lines: [`Provider: ${key.provider}`, `Error: ${result.error || "unknown"}`, `Checked at: ${nowSql()}`],
    });
  }

  return db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyId) as ApiKeyRow;
}

export async function checkAllKeys(): Promise<{ ok: number; failed: number }> {
  const keys = db.prepare("SELECT * FROM api_keys WHERE disabled = 0").all() as ApiKeyRow[];
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
export function withUsage(key: ApiKeyRow, tz: string): Record<string, any> {
  const summary = usageSummary(key.id, tz);
  const used = periodTokensUsed(key.id, key.usage_period, tz);
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
    models: modelUsageList(key.id, tz),
  };
}

export function listKeys(): ApiKeyRow[] {
  return db.prepare("SELECT * FROM api_keys ORDER BY id").all() as ApiKeyRow[];
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
export function createKeyRow(body: Record<string, unknown>): { id: number } {
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
  const info = db
    .prepare(
      `INSERT INTO api_keys(provider, account_name, account_email, api_key_enc, base_url, usage_limit, usage_period, usage_hour)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      provider,
      accountName,
      safeStr(body.accountEmail, 300),
      encrypt(body.apiKey as string),
      baseUrl,
      usageLimit,
      usagePeriod,
      usageHour
    );
  const keyId = Number(info.lastInsertRowid);
  if (Array.isArray(body.models)) saveKeyModels(keyId, body.models);
  return { id: keyId };
}

export function logKeyUsage(keyId: number, tokens: number, success: boolean, model?: string): void {
  logUsage(keyId, tokens, success, getSetting("timezone") || "Asia/Dhaka", model);
}

export function keyUsageSummary(keyId: number) {
  return usageSummary(keyId);
}

export function keyUsageHours(keyId: number): number[] {
  return usageHours(keyId);
}

export function resetKeyUsage(keyId: number): number {
  return resetUsage(keyId);
}

// Replace the model list for a key (each model tracks its own free-token limits).
export function saveKeyModels(keyId: number, models: unknown[]): void {
  const del = db.prepare("DELETE FROM key_models WHERE key_id = ?");
  const ins = db.prepare(
    `INSERT INTO key_models(key_id, model, token_limit, period, usage_hour, rpm, rpd, tpm, enabled)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    del.run(keyId);
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
      ins.run(
        keyId,
        model,
        num(m.tokenLimit, m.tpd, m.tokensPerDay),
        ["daily", "weekly", "monthly", "total"].includes(String(m.period)) ? String(m.period) : "daily",
        Math.max(0, Math.min(23, num(m.usageHour, m.usage_hour))),
        num(m.rpm, m.requestsPerMinute),
        num(m.rpd, m.requestsPerDay),
        num(m.tpm, m.tokensPerMinute),
        m.enabled === false ? 0 : 1
      );
    }
  })();
}

export { periodTokensUsed, usageSummary };