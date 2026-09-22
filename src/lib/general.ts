import crypto from "node:crypto";
import { db, nowSql } from "./db";
import { decrypt, encrypt } from "./crypto";
import { getProvider, PROVIDERS } from "./providers";
import { timezone, getSetting } from "./settings";
import { tzParts, dayKeyFromParts, logUsage, periodTokensUsed } from "./usage";
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

export function createGeneralKey(name: string, note = ""): { id: number; secret: string } {
  const secret = generateSecret();
  const info = db
    .prepare("INSERT INTO general_keys(name, note, key_hash, secret_enc) VALUES(?, ?, ?, ?)")
    .run(String(name).slice(0, 200) || "general key", String(note).slice(0, 500), hashSecret(secret), encrypt(secret));
  return { id: Number(info.lastInsertRowid), secret };
}

// Reveal the stored secret (encrypted at rest). Returns null for legacy keys
// created before secret_enc existed — those must be regenerated.
export function revealGeneralKeySecret(gkId: number): string | null {
  const row = db.prepare("SELECT secret_enc FROM general_keys WHERE id = ?").get(gkId) as
    | { secret_enc: string | null }
    | undefined;
  if (!row?.secret_enc) return null;
  return decrypt(row.secret_enc) || null;
}

// Issue a fresh secret for an existing key, keeping usage stats and name.
export function rotateGeneralKeySecret(gkId: number): string | null {
  const row = db.prepare("SELECT id FROM general_keys WHERE id = ?").get(gkId) as { id: number } | undefined;
  if (!row) return null;
  const secret = generateSecret();
  db.prepare("UPDATE general_keys SET key_hash = ?, secret_enc = ? WHERE id = ?").run(hashSecret(secret), encrypt(secret), gkId);
  return secret;
}

export function resolveGeneralKey(bearerHeader: string | null): GeneralKeyRow | null {
  const secret = (bearerHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret.startsWith(GK_PREFIX) || secret.length < GK_PREFIX.length + 16) return null;
  const row = db
    .prepare("SELECT * FROM general_keys WHERE key_hash = ? AND enabled = 1")
    .get(hashSecret(secret)) as GeneralKeyRow | undefined;
  return row ?? null;
}

// x-api-key / "?key=" fallbacks — some OpenAI-compatible clients send these.
export function resolveGeneralKeyFromRequest(req: Request): GeneralKeyRow | null {
  const auth = resolveGeneralKey(req.headers.get("authorization"));
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
function servesModel(keyId: number, model: string): boolean {
  const rows = db
    .prepare("SELECT id, enabled FROM key_models WHERE key_id = ? AND model = ?")
    .all(keyId, model) as { id: number; enabled: number }[];
  if (rows.length) return rows.some((r) => r.enabled === 1);
  // No explicit row for this model: allowed unless the key tracks models at all.
  const any = db.prepare("SELECT 1 FROM key_models WHERE key_id = ? LIMIT 1").get(keyId);
  return !any;
}

// Per-model daily request cap from key_models (rpd), if configured.
function modelRpdLeft(keyId: number, model: string, zone: string): number | null {
  const m = db
    .prepare("SELECT rpd, token_limit, period FROM key_models WHERE key_id = ? AND model = ? AND enabled = 1")
    .get(keyId, model) as { rpd: number; token_limit: number; period: string } | undefined;
  if (!m) return null;
  if (m.rpd > 0) {
    const day = dayKeyFromParts(tzParts(zone));
    const r = db
      .prepare("SELECT COALESCE(SUM(hits),0) h FROM key_usage_hourly WHERE key_id = ? AND model = ? AND day = ?")
      .get(keyId, model, day) as { h: number };
    if (r.h >= m.rpd) return 0;
  }
  if (m.token_limit > 0) {
    const used = periodTokensUsed(keyId, m.period, zone, model);
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
export function pickProviderKey(gkId: number, model?: string, candidates?: ApiKeyRow[]): PickedKey | null {
  const rows = candidates ?? (db
    .prepare("SELECT * FROM api_keys WHERE disabled = 0 AND status != 'dead' ORDER BY id")
    .all() as ApiKeyRow[]);
  if (!rows.length) return null;

  const zone = timezone();
  const softCap = 1_000_000; // for keys without a configured limit

  const scored: PickedKey[] = [];
  for (const r of rows) {
    if (model && !servesModel(r.id, model)) continue;
    const used = r.provider_usage !== null ? r.provider_usage : periodTokensUsed(r.id, r.usage_period, zone);
    const limit = r.provider_limit ?? r.usage_limit ?? 0;
    if (limit > 0 && used >= limit) continue; // exhausted for the period
    if (model) {
      const left = modelRpdLeft(r.id, model, zone);
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
  const cursor = Number(getSetting(cursorKey) || 0);
  const idx = group.findIndex((s) => s.row.id === cursor);
  const chosen = group[(idx + 1) % group.length];
  setRrCursor(cursorKey, chosen.row.id);
  return chosen;
}

function setRrCursor(key: string, keyId: number): void {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(keyId));
}

// ----- Usage logging for proxied requests -----------------------------------

export function logProxyUsage(gkId: number, keyId: number | null, tokens: number, model: string): void {
  const zone = timezone();
  if (keyId !== null && keyId !== undefined) logUsage(keyId, tokens, true, zone, model);

  const p = tzParts(zone);
  const day = dayKeyFromParts(p);
  db.prepare(
    `INSERT INTO general_key_logs(gk_id, key_id, hits, tokens, day, hour)
     VALUES(?, ?, 1, ?, ?, ?)`
  ).run(gkId, keyId ?? null, tokens, day, p.hour);
  db.prepare("UPDATE general_keys SET last_used_at = ? WHERE id = ?").run(nowSql(), gkId);
}

export function generalKeyStats(gkId: number, zone?: string) {
  const z = zone ?? timezone();
  const today = dayKeyFromParts(tzParts(z));
  const all = db
    .prepare("SELECT COALESCE(SUM(hits),0) hits, COALESCE(SUM(tokens),0) tokens FROM general_key_logs WHERE gk_id = ?")
    .get(gkId) as { hits: number; tokens: number };
  const day = db
    .prepare("SELECT COALESCE(SUM(hits),0) hits, COALESCE(SUM(tokens),0) tokens FROM general_key_logs WHERE gk_id = ? AND day = ?")
    .get(gkId, today) as { hits: number; tokens: number };
  const perKey = db
    .prepare(
      `SELECT key_id, COALESCE(SUM(hits),0) hits, COALESCE(SUM(tokens),0) tokens
       FROM general_key_logs WHERE gk_id = ? AND key_id IS NOT NULL
       GROUP BY key_id ORDER BY hits DESC`
    )
    .all(gkId) as { key_id: number; hits: number; tokens: number }[];
  return { hitsAll: all.hits, tokensAll: all.tokens, hitsToday: day.hits, tokensToday: day.tokens, perKey };
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
  const row = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyId) as ApiKeyRow | undefined;
  if (!row) return null;
  const def = getProvider(row.provider);
  const modelsPath = def.modelsPath || def.checkPath;
  const base = (row.base_url || def.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!base || !modelsPath) return null;

  let plain = "";
  try {
    plain = decrypt(row.api_key_enc);
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
      headers: { ...upstreamHeaders(row.provider, plain, 0), Accept: "application/json" },
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
  const dbRows = db
    .prepare("SELECT model AS id FROM key_models WHERE key_id = ? AND enabled = 1")
    .all(keyId) as { id: string }[];
  const base = fresh ? fresh.models : cached?.models ?? [];
  const merged = new Map<string, { id: string; owned_by?: string; context_length?: number }>();
  for (const m of base) merged.set(m.id, m);
  for (const r of dbRows) {
    if (!merged.has(r.id)) merged.set(r.id, r);
  }
  const arr = [...merged.values()];
  catalogCache.set(keyId, { models: arr, fetchedAt: fresh?.fetchedAt ?? Date.now() });
  return arr;
}

// Merged OpenRouter-style catalog across every enabled key (for /v1/models).
// Models are exposed PER PROVIDER ("groq/openai/gpt-oss-120b"), never merged:
// the same upstream model from two providers stays two selectable models.
export async function mergedModelCatalog(): Promise<GatewayModel[]> {
  const rows = db
    .prepare("SELECT * FROM api_keys WHERE disabled = 0 AND status != 'dead' ORDER BY id")
    .all() as ApiKeyRow[];
  const out = new Map<string, GatewayModel>();
  for (const r of rows) {
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
  const zone = timezone();
  const rows = db
    .prepare("SELECT * FROM api_keys WHERE disabled = 0 AND status != 'dead' ORDER BY id")
    .all() as ApiKeyRow[];

  const wantAll = !!opts.allKeys || !model;
  // "groq/openai/gpt-oss-120b" → provider "groq", upstream "openai/gpt-oss-120b".
  const split = model ? splitGatewayModel(model) : null;
  const catalog = new Map<string, GatewayModel>();
  const eligible: ApiKeyRow[] = [];

  for (const r of rows) {
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
      if (serves && keyEligible(r, split?.upstream, zone)) eligible.push(r);
    }
  }
  if (wantAll) eligible.push(...rows.filter((r) => keyEligible(r, undefined, zone)));

  const entry = split
    ? catalog.get(`${split.provider ?? ""}/${split.upstream}`) ?? null
    : null;
  return { entry, keys: eligible, catalog };
}

// Static eligibility (no network): disabled/dead/exhausted/per-model caps.
function keyEligible(r: ApiKeyRow, model: string | undefined, zone: string): boolean {
  const used = r.provider_usage !== null ? r.provider_usage : periodTokensUsed(r.id, r.usage_period, zone);
  const limit = r.provider_limit ?? r.usage_limit ?? 0;
  if (limit > 0 && used >= limit) return false;
  if (model && modelRpdLeft(r.id, model, zone) === 0) return false;
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
