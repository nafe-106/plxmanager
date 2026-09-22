import crypto from "node:crypto";
import { byId, rows, row, insertRow, insertMany, updateRow, upsertRows, nowSql } from "./store";
import { decrypt, encrypt } from "./crypto";
import { getProvider, PROVIDERS } from "./providers";
import { timezone, getSetting } from "./settings";
import { dayKeyFromParts, tzParts, logUsage, periodTokensUsed } from "./usage";
import type { ApiKeyRow } from "./keys";

// ----- General (round-robin) keys ------------------------------------------
// A general key is issued by this app (tam_gk_...) and acts as one OpenAI-
// compatible endpoint in front of ALL added provider keys. Each proxied
// request is routed to one underlying key chosen by usage-weighted round-
// robin: the least-utilized eligible key is preferred, ties are rotated.

const GK_PREFIX = "tam_gk_";
const GK_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface GeneralKeyRow {
  id: number;
  name: string;
  note: string;
  key_hash: string;
  secret_enc: string | null;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
}

function generateSecret(): string {
  const bytes = crypto.randomBytes(32);
  let out = "";
  for (const b of bytes) out += GK_ALPHABET[b % GK_ALPHABET.length];
  return GK_PREFIX + out;
}

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export async function createGeneralKey(name: string, note = ""): Promise<{ id: number; secret: string }> {
  const secret = generateSecret();
  const inserted = await insertRow<GeneralKeyRow>("general_keys", {
    name: String(name).slice(0, 200) || "general key",
    note: String(note).slice(0, 500),
    key_hash: hashSecret(secret),
    secret_enc: encrypt(secret),
  });
  return { id: Number(inserted.id), secret };
}

// Reveal the stored secret (encrypted at rest). Returns null for legacy keys
// created before secret_enc existed — those must be regenerated.
export async function revealGeneralKeySecret(gkId: number): Promise<string | null> {
  const rowData = await byId<{ secret_enc: string | null }>("general_keys", gkId);
  if (!rowData?.secret_enc) return null;
  return decrypt(rowData.secret_enc) || null;
}

// Issue a fresh secret for an existing key, keeping usage stats and name.
export async function rotateGeneralKeySecret(gkId: number): Promise<string | null> {
  const exists = await byId<{ id: number }>("general_keys", gkId);
  if (!exists) return null;
  const secret = generateSecret();
  await updateRow("general_keys", gkId, {
    key_hash: hashSecret(secret),
    secret_enc: encrypt(secret),
  });
  return secret;
}

export async function resolveGeneralKey(bearerHeader: string | null): Promise<GeneralKeyRow | null> {
  const secret = (bearerHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret.startsWith(GK_PREFIX) || secret.length < GK_PREFIX.length + 16) return null;
  const rowsArr = await rows<GeneralKeyRow>("general_keys", { key_hash: hashSecret(secret), enabled: 1 });
  return rowsArr[0] ?? null;
}

// x-api-key / "?key=" fallbacks — some OpenAI-compatible clients send these.
export async function resolveGeneralKeyFromRequest(req: Request): Promise<GeneralKeyRow | null> {
  const auth = await resolveGeneralKey(req.headers.get("authorization"));
  if (auth) return auth;
  const xKey = req.headers.get("x-api-key");
  if (xKey) return resolveGeneralKey(`Bearer ${xKey.trim()}`);
  const qKey = new URL(req.url).searchParams.get("key");
  if (qKey) return resolveGeneralKey(`Bearer ${qKey.trim()}`);
  return null;
}

// ----- Eligibility & selection ---------------------------------------------

// Does this key serve the requested model? Keys with no model rows serve
// everything; otherwise the model must have an enabled row.
async function servesModel(keyId: number, model: string): Promise<boolean> {
  const rowsArr = await rows<{ id: number; enabled: number }>("key_models", { key_id: keyId, model });
  if (rowsArr.length) return rowsArr.some((r) => r.enabled === 1);
  // No explicit row for this model: allowed unless the key tracks models at all.
  const any = await row<{ id: number }>("key_models", { key_id: keyId });
  return !any;
}

// Per-model daily request cap from key_models (rpd), if configured.
async function modelRpdLeft(keyId: number, model: string, zone: string): Promise<number | null> {
  const m = await row<{ rpd: number; token_limit: number; period: string }>("key_models", {
    key_id: keyId,
    model,
    enabled: 1,
  });
  if (!m) return null;
  if (m.rpd > 0) {
    const day = dayKeyFromParts(tzParts(zone));
    const hits = await rows<{ hits: number }>("key_usage_hourly", { key_id: keyId, model, day });
    const h = hits.reduce((s, r) => s + (r.hits ?? 0), 0);
    if (h >= m.rpd) return 0;
  }
  if (m.token_limit > 0) {
    const used = await periodTokensUsed(keyId, m.period, zone, model);
    if (used >= m.token_limit) return 0;
  }
  return 1;
}

export interface PickedKey {
  row: ApiKeyRow;
  used: number;
  limit: number;
  ratio: number;
}

// Usage-weighted round-robin: prefer the key with the lowest utilization
// (used/limit); among near-equal utilization rotate cyclically so traffic
// spreads evenly instead of hammering one key. `candidates` (optional) is a
// pre-filtered eligible set (e.g. keys whose catalog serves the model).
export async function pickProviderKey(gkId: number, model?: string, candidates?: ApiKeyRow[]): Promise<PickedKey | null> {
  const rowsArr =
    candidates ??
    (await rows<ApiKeyRow>("api_keys", { disabled: 0, status: { neq: "dead" } }, { order: "id" }));
  if (!rowsArr.length) return null;

  const zone = await timezone();
  const softCap = 1_000_000; // for keys without a configured limit

  const scored: PickedKey[] = [];
  for (const r of rowsArr) {
    if (model && !(await servesModel(r.id, model))) continue;
    const used = r.provider_usage !== null ? r.provider_usage : await periodTokensUsed(r.id, r.usage_period, zone);
    const limit = r.provider_limit ?? r.usage_limit ?? 0;
    if (limit > 0 && used >= limit) continue; // exhausted for the period
    if (model) {
      const left = await modelRpdLeft(r.id, model, zone);
      if (left === 0) continue;
    }
    const ratio = limit > 0 ? used / limit : used / softCap;
    scored.push({ row: r, used, limit, ratio });
  }
  if (!scored.length) return null;

  scored.sort((a, b) => a.ratio - b.ratio || a.row.id - b.row.id);
  const min = scored[0].ratio;
  const group = scored.filter((s) => s.ratio <= min + 0.01); // near-ties rotate

  const cursorKey = `gk_rr_${gkId}`;
  const cursor = Number((await getSetting(cursorKey)) || 0);
  const idx = group.findIndex((s) => s.row.id === cursor);
  const chosen = group[(idx + 1) % group.length];
  await setRrCursor(cursorKey, chosen.row.id);
  return chosen;
}

async function setRrCursor(key: string, keyId: number): Promise<void> {
  await upsertRows("settings", [{ key, value: String(keyId) }], "key");
}

// ----- Usage logging for proxied requests -----------------------------------

export async function logProxyUsage(gkId: number, keyId: number | null, tokens: number, model: string): Promise<void> {
  const zone = await timezone();
  if (keyId !== null && keyId !== undefined) await logUsage(keyId, tokens, true, zone, model);

  const p = tzParts(zone);
  const day = dayKeyFromParts(p);
  await insertRow("general_key_logs", {
    gk_id: gkId,
    key_id: keyId ?? null,
    hits: 1,
    tokens,
    day,
    hour: p.hour,
  });
  await updateRow("general_keys", gkId, { last_used_at: nowSql() });
}

export async function generalKeyStats(gkId: number, zone?: string) {
  const z = zone ?? (await timezone());
  const today = dayKeyFromParts(tzParts(z));
  const all = await rows<{ hits: number; tokens: number; day: string; key_id: number | null; hour: number }>("general_key_logs", { gk_id: gkId });
  const hitsAll = all.reduce((s, r) => s + (r.hits ?? 0), 0);
  const tokensAll = all.reduce((s, r) => s + (r.tokens ?? 0), 0);
  const day = all.filter((r) => r.day === today);
  const hitsToday = day.reduce((s, r) => s + (r.hits ?? 0), 0);
  const tokensToday = day.reduce((s, r) => s + (r.tokens ?? 0), 0);
  const perKey = new Map<number, { hits: number; tokens: number }>();
  for (const r of all) {
    if (r.key_id === null || r.key_id === undefined) continue;
    const e = perKey.get(r.key_id) ?? { hits: 0, tokens: 0 };
    e.hits += r.hits ?? 0;
    e.tokens += r.tokens ?? 0;
    perKey.set(r.key_id, e);
  }
  return {
    hitsAll,
    tokensAll,
    hitsToday,
    tokensToday,
    perKey: [...perKey.entries()].map(([key_id, v]) => ({ key_id, ...v })).sort((a, b) => b.hits - a.hits),
  };
}

// ----- OpenAI-compatible proxy helpers --------------------------------------

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key, x-requested-with",
  "Access-Control-Max-Age": "86400",
};

// Map a client path (after /api/v1/) onto the selected key's upstream URL.
// chat/completions and models are provider-aware; anything else forwards
// verbatim under the key's base URL.
export function upstreamUrl(provider: string, baseUrl: string, clientPath: string, apiKey: string): string {
  const def = getProvider(provider);
  const base = (baseUrl || def.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!base) return "";
  const seg = clientPath.replace(/^\/+|\/+$/g, "");
  let path: string;
  if (seg === "chat/completions") {
    path = def.chatPath || "/chat/completions";
  } else if (seg === "models" || seg === "models/") {
    path = def.checkPath;
  } else if (seg === "completions") {
    path = (def.chatPath || "/chat/completions").replace("/chat/completions", "/completions");
  } else if (seg === "embeddings") {
    path = (def.chatPath || "/chat/completions").replace("/chat/completions", "/embeddings");
  } else {
    path = "/" + seg; // verbatim passthrough
  }
  let url = base + (path.startsWith("/") ? path : "/" + path);
  if (def.authType === "query" && def.queryParam) {
    url += (url.includes("?") ? "&" : "?") + def.queryParam + "=" + encodeURIComponent(apiKey);
  }
  return url;
}

export function upstreamHeaders(provider: string, apiKey: string, bodyLength: number): Record<string, string> {
  const def = getProvider(provider);
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "target-api-manager/1.0",
  };
  if (bodyLength > 0) h["Content-Length"] = String(bodyLength);
  if (def.authType === "bearer") h.Authorization = `Bearer ${apiKey}`;
  return h;
}

// Pull usage from an OpenAI-style response object.
export function extractUsage(j: any): { tokens: number; model: string } {
  const tokens =
    j?.usage && typeof j.usage === "object"
      ? Number(j.usage.total_tokens ?? ((j.usage.prompt_tokens ?? 0) + (j.usage.completion_tokens ?? 0))) || 0
      : 0;
  return { tokens: Math.max(0, Math.round(tokens)), model: typeof j?.model === "string" ? j.model : "" };
}

// Scan an SSE relay for the final usage-bearing chunk (OpenAI sends usage on
// the last data event when stream_options include usage, and many providers
// send it by default).
export class SseUsageCollector {
  private buf = "";
  tokens = 0;
  model = "";

  feed(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > 4_000_000) this.buf = this.buf.slice(-2_000_000); // bound memory
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const u = extractUsage(j);
        if (u.tokens > 0) this.tokens = u.tokens;
        if (u.model) this.model = u.model;
      } catch {
        // partial/non-JSON line — ignore
      }
    }
  }
}

// ----- Model catalog (merged /v1/models) -----------------------------------

// Every model is exposed PER PROVIDER with a prefixed gateway ID, so the same
// upstream model from two providers stays two selectable models:
//   cerebras/gpt-oss-120b  ≠  groq/openai/gpt-oss-120b
// The prefix is stripped before forwarding upstream.
export interface GatewayModel {
  id: string; // gateway ID, e.g. "groq/openai/gpt-oss-120b"
  provider: string; // provider id, e.g. "groq"
  upstreamModel: string; // model id the provider expects, e.g. "openai/gpt-oss-120b"
  owned_by?: string;
  context_length?: number;
}

// "cerebras/gpt-oss-120b" → { provider: "cerebras", upstream: "gpt-oss-120b" }
// "groq/openai/gpt-oss-120b" → { provider: "groq", upstream: "openai/gpt-oss-120b" }
// "gpt-oss-120b" (no known provider prefix) → { provider: null, upstream: "gpt-oss-120b" }
export function splitGatewayModel(id: string): { provider: string | null; upstream: string } {
  const s = String(id || "").trim();
  const idx = s.indexOf("/");
  if (idx <= 0) return { provider: null, upstream: s };
  const head = s.slice(0, idx).toLowerCase();
  if (PROVIDERS.some((p) => p.id === head)) return { provider: head, upstream: s.slice(idx + 1) };
  return { provider: null, upstream: s }; // org-scoped id like "openai/gpt-oss-20b"
}

interface CatalogEntry {
  models: { id: string; owned_by?: string; context_length?: number }[];
  fetchedAt: number;
}

const CATALOG_TTL_MS = 5 * 60 * 1000; // refresh provider catalogs every 5 min
const catalogCache = new Map<number, CatalogEntry>(); // key: api_keys.id

// Fetch a single key's OpenAI-style model list from its provider.
async function fetchKeyModels(keyId: number): Promise<CatalogEntry | null> {
  const rowData = await byId<ApiKeyRow>("api_keys", keyId);
  if (!rowData) return null;
  const def = getProvider(rowData.provider);
  const modelsPath = def.modelsPath || def.checkPath;
  const base = (rowData.base_url || def.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!base || !modelsPath) return null;

  let plain = "";
  try {
    plain = decrypt(rowData.api_key_enc);
  } catch {
    return null;
  }
  if (!plain) return null;

  let url = base + (modelsPath.startsWith("/") ? modelsPath : "/" + modelsPath);
  if (def.authType === "query" && def.queryParam) {
    url += (url.includes("?") ? "&" : "?") + def.queryParam + "=" + encodeURIComponent(plain);
  }
  try {
    const res = await fetch(url, {
      headers: { ...upstreamHeaders(rowData.provider, plain, 0), Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const data = Array.isArray(j?.data) ? j.data : [];
    const models = data
      .map((m: any) => ({
        id: String(m?.id ?? m?.name ?? "").trim(),
        owned_by: typeof m?.owned_by === "string" ? m.owned_by : undefined,
        context_length: typeof m?.context_length === "number" ? m.context_length : undefined,
      }))
      .filter((m: { id: string }) => m.id);
    // No filtering: expose EVERY model the provider lists (incl. guard/audio),
    // exactly like OpenRouter does.
    return { models, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

// Effective model list for one key. The provider's LIVE list is preferred for
// metadata, but the DB-configured (enabled) model set is ALWAYS unioned in so a
// model the user pinned in the admin still gets advertised and routed even when
// the provider's /models endpoint no longer lists it (e.g. hidden/preview ids).
// When the provider is unreachable the DB-config alone keeps setups working.
async function keyModels(keyId: number): Promise<{ id: string; owned_by?: string; context_length?: number }[]> {
  const cached = catalogCache.get(keyId);
  if (cached && Date.now() - cached.fetchedAt <= CATALOG_TTL_MS) {
    return cached.models;
  }
  const fresh = await fetchKeyModels(keyId);
  const dbRows = await rows<{ id: string }>("key_models", { key_id: keyId, enabled: 1 });
  const base = fresh ? fresh.models : cached?.models ?? [];
  const merged = new Map<string, { id: string; owned_by?: string; context_length?: number }>();
  for (const m of base) merged.set(m.id, m);
  for (const r of dbRows) {
    if (r.id !== undefined && !merged.has(r.id)) merged.set(r.id, r);
  }
  const arr = [...merged.values()];
  catalogCache.set(keyId, { models: arr, fetchedAt: fresh?.fetchedAt ?? Date.now() });
  return arr;
}

// Merged OpenRouter-style catalog across every enabled key (for /v1/models).
// Models are exposed PER PROVIDER ("groq/openai/gpt-oss-120b"), never merged:
// the same upstream model from two providers stays two selectable models.
export async function mergedModelCatalog(): Promise<GatewayModel[]> {
  const rowsArr = await rows<ApiKeyRow>("api_keys", { disabled: 0, status: { neq: "dead" } }, { order: "id" });
  const out = new Map<string, GatewayModel>();
  for (const r of rowsArr) {
    const def = getProvider(r.provider);
    // Live provider list first; DB rows are only a fallback when the provider
    // is unreachable (keyModels already implements that policy).
    const models = await keyModels(r.id);
    const all = new Set<string>();
    for (const m of models) all.add(m.id);
    for (const upstream of all) {
      const id = `${def.id}/${upstream}`;
      if (out.has(id)) continue;
      const meta = models.find((m) => m.id === upstream);
      out.set(id, {
        id,
        provider: def.id,
        upstreamModel: upstream,
        owned_by: meta?.owned_by ?? def.label,
        context_length: meta?.context_length,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// One function, two jobs:
//  - allKeys=true  → merged OpenRouter-style catalog across every enabled key
//  - model given   → the eligible keys that can actually serve that model
export async function modelsForRequest(
  gkId: number,
  model: string | undefined,
  opts: { allKeys?: boolean } = {}
): Promise<{ entry: { id: string; owned_by?: string; context_length?: number } | null; keys: ApiKeyRow[]; catalog: Map<string, { id: string; owned_by?: string; context_length?: number }> }> {
  const zone = await timezone();
  const rowsArr = await rows<ApiKeyRow>("api_keys", { disabled: 0, status: { neq: "dead" } }, { order: "id" });

  const wantAll = !!opts.allKeys || !model;
  // "groq/openai/gpt-oss-120b" → provider "groq", upstream "openai/gpt-oss-120b".
  const split = model ? splitGatewayModel(model) : null;
  const catalog = new Map<string, GatewayModel>();
  const eligible: ApiKeyRow[] = [];

  for (const r of rowsArr) {
    const list = await keyModels(r.id);
    for (const m of list) {
      const id = `${getProvider(r.provider).id}/${m.id}`;
      if (!catalog.has(id)) catalog.set(id, { id, provider: getProvider(r.provider).id, upstreamModel: m.id, owned_by: m.owned_by, context_length: m.context_length });
    }
    if (!wantAll) {
      // Must match provider (from the prefix) AND the bare model name in the
      // effective list (live catalog, or DB rows only when provider unreachable).
      const inCatalog = list.some((m) => m.id === split?.upstream);
      // No effective rows → provider doesn't track models; assume yes.
      const tracksModels = list.length > 0;
      const serves = split?.provider ? getProvider(r.provider).id === split.provider && (inCatalog || !tracksModels) : inCatalog || !tracksModels;
      if (serves && (await keyEligible(r, split?.upstream, zone))) eligible.push(r);
    }
  }
  if (wantAll) {
    for (const r of rowsArr) {
      if (await keyEligible(r, undefined, zone)) eligible.push(r);
    }
  }

  const entry = split
    ? catalog.get(`${split.provider ?? ""}/${split.upstream}`) ?? null
    : null;
  return { entry, keys: eligible, catalog };
}

// Static eligibility (no network): disabled/dead/exhausted/per-model caps.
async function keyEligible(r: ApiKeyRow, model: string | undefined, zone: string): Promise<boolean> {
  const used = r.provider_usage !== null ? r.provider_usage : await periodTokensUsed(r.id, r.usage_period, zone);
  const limit = r.provider_limit ?? r.usage_limit ?? 0;
  if (limit > 0 && used >= limit) return false;
  if (model && (await modelRpdLeft(r.id, model, zone)) === 0) return false;
  return true;
}

// Standard health response when a client probes the gateway root.
export function gatewayInfo(host: string): Record<string, unknown> {
  return {
    object: "target_api_manager",
    gateway: "openai-compatible",
    base_url: `${host}/api/v1`,
    endpoints: ["chat/completions", "completions", "embeddings", "models"],
    auth: "Authorization: Bearer tam_gk_…",
  };
}