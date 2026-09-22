// Provider definitions live here — add a new provider by appending an entry.

export type AuthType = "bearer" | "query";

export interface ProviderDef {
  id: string;
  label: string;
  color: string;
  defaultBaseUrl: string;
  checkPath: string;
  authType: AuthType;
  queryParam?: string; // for query auth (e.g. Gemini 'key')
  syncUsage?: boolean; // parse usage & limit from the health-check response
  requiresBaseUrl?: boolean;
  chatPath?: string; // OpenAI-style path appended to baseUrl for POST /chat/completions
  modelsPath?: string; // OpenAI-style path for GET /models (catalog listing)
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    color: "#6464f2",
    defaultBaseUrl: "https://openrouter.ai",
    checkPath: "/api/v1/key",
    authType: "bearer",
    syncUsage: true,
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    color: "#14b8a6",
    defaultBaseUrl: "https://api.cerebras.ai",
    checkPath: "/v1/models",
    authType: "bearer",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  },
  {
    id: "groq",
    label: "Groq",
    color: "#f55036",
    defaultBaseUrl: "https://api.groq.com",
    checkPath: "/openai/v1/models",
    authType: "bearer",
    chatPath: "/openai/v1/chat/completions",
    modelsPath: "/openai/v1/models",
  },
  {
    id: "xai",
    label: "xAI Grok",
    color: "#9ca3af",
    defaultBaseUrl: "https://api.x.ai",
    checkPath: "/v1/models",
    authType: "bearer",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  },
  {
    id: "openai",
    label: "OpenAI",
    color: "#10a37f",
    defaultBaseUrl: "https://api.openai.com",
    checkPath: "/v1/models",
    authType: "bearer",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  },
  {
    id: "gemini",
    label: "Gemini",
    color: "#4285f4",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    checkPath: "/v1beta/models",
    authType: "query",
    queryParam: "key",
    chatPath: "/v1beta/openai/chat/completions", // Gemini's OpenAI-compat layer
    modelsPath: "/v1beta/openai/models",
  },
  {
    id: "other",
    label: "Other",
    color: "#64748b",
    defaultBaseUrl: "",
    checkPath: "/models",
    authType: "bearer",
    requiresBaseUrl: true,
    chatPath: "/chat/completions",
    modelsPath: "/models",
  },
];

export function getProvider(id: string): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

// Current Groq free-tier per-model limits (per organization). From Groq's
// rate-limits docs, verified 2026-09. Editable defaults — adjust in the
// Add/Edit key dialog to match your tier.
//   tpd = tokens per day (tracked),  rpd = requests per day (tracked)
//   rpm = requests per minute (burst), tpm = tokens per minute (burst)
export interface GroqModelDef {
  model: string;
  tpd: number;
  rpd: number;
  rpm: number;
  tpm: number;
}

export const GROQ_DEFAULT_MODELS: GroqModelDef[] = [
  { model: "llama-3.3-70b-versatile", tpd: 100_000, rpd: 1_000, rpm: 30, tpm: 12_000 },
  { model: "llama-3.1-8b-instant", tpd: 500_000, rpd: 14_400, rpm: 30, tpm: 6_000 },
  { model: "llama-4-scout-17b-16e-instruct", tpd: 100_000, rpd: 1_000, rpm: 30, tpm: 8_000 },
  { model: "llama-4-maverick-17b-128e-instruct", tpd: 50_000, rpd: 500, rpm: 15, tpm: 3_000 },
  { model: "openai/gpt-oss-120b", tpd: 100_000, rpd: 1_000, rpm: 30, tpm: 10_000 },
  { model: "openai/gpt-oss-20b", tpd: 100_000, rpd: 1_000, rpm: 30, tpm: 10_000 },
  { model: "qwen/qwen3-32b", tpd: 200_000, rpd: 1_000, rpm: 30, tpm: 8_000 },
  { model: "gemma2-9b-it", tpd: 100_000, rpd: 1_000, rpm: 30, tpm: 15_000 },
  { model: "deepseek-r1-distill-70b", tpd: 100_000, rpd: 1_000, rpm: 30, tpm: 12_000 },
];

export type CheckStatus = "alive" | "dead" | "rate_limited" | "unknown";

export interface CheckResult {
  status: CheckStatus;
  error?: string;
  responseMs?: number;
  ratelimit?: Record<string, string>;
  providerUsage?: number | null;
  providerLimit?: number | null;
}

function extractRateLimit(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-used",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-remaining-requests",
  ]) {
    const v = headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function healthCheck(
  providerId: string,
  apiKey: string,
  baseUrlOverride?: string,
  timeoutMs = 15000
): Promise<CheckResult> {
  const def = getProvider(providerId);
  const base = (baseUrlOverride || def.defaultBaseUrl || "").replace(/\/+$/, "");
  if (!base) {
    return { status: "unknown", error: "no base url configured" };
  }
  const url = base + (def.checkPath.startsWith("/") ? def.checkPath : "/" + def.checkPath);
  const headers: Record<string, string> = {
    "User-Agent": "target-api-manager/1.0",
    Accept: "application/json",
  };
  let finalUrl = url;
  if (def.authType === "bearer") headers.Authorization = `Bearer ${apiKey}`;
  else if (def.queryParam) finalUrl = url + `?${def.queryParam}=` + encodeURIComponent(apiKey);

  const started = Date.now();
  try {
    const res = await fetch(finalUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    const responseMs = Date.now() - started;
    const ratelimit = extractRateLimit(res.headers);

    if (res.status >= 200 && res.status < 300) {
      let providerUsage: number | null = null;
      let providerLimit: number | null = null;
      if (def.syncUsage) {
        const j = await safeJson(res);
        const d = j?.data;
        if (d) {
          if (typeof d.usage === "number") {
            providerUsage = d.usage;
            providerLimit = typeof d.limit === "number" ? d.limit : null;
          } else if (typeof d.limit_remaining === "number") {
            providerUsage = typeof d.limit === "number" ? d.limit - d.limit_remaining : null;
            providerLimit = typeof d.limit === "number" ? d.limit : null;
          }
        }
      }
      return { status: "alive", responseMs, ratelimit, providerUsage, providerLimit };
    }
    if (res.status === 429) {
      return { status: "rate_limited", error: "HTTP 429 rate limited", responseMs, ratelimit };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: "dead", error: `HTTP ${res.status} unauthorized`, responseMs, ratelimit };
    }
    return { status: "dead", error: `HTTP ${res.status}`, responseMs, ratelimit };
  } catch (err: any) {
    const responseMs = Date.now() - started;
    const msg = err?.name === "TimeoutError" || err?.name === "AbortError"
      ? `timeout after ${Math.floor((responseMs || timeoutMs) / 1000)}s`
      : err?.cause?.message || err?.message || "network error";
    return { status: "unknown", error: msg, responseMs };
  }
}

export function maskKey(key: string): string {
  const s = key.trim();
  if (s.length <= 8) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}