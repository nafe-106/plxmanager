import { byId, row, rows, insertRow, updateRow, deleteRows, upsertRows, nowSql } from "./store";
import { decrypt, encrypt } from "./crypto";
import { getSetting, setSetting, timezone } from "./settings";
import { sendAlert } from "./alerts";
import { weekStartKey, tzParts, addDays } from "./usage";
import { renderPlexusNotebook, DEFAULT_BRAIN_MODEL, DEFAULT_VISION_MODEL, DEFAULT_SLUG } from "./plexusNotebook";

export const KAGGLE_API_BASE =
  process.env.KAGGLE_API_BASE || "https://www.kaggle.com/api/v1";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
export interface KaggleAccountRow {
  id: number;
  label: string;
  username: string;
  api_key_enc: string;
  refresh_token_enc: string | null;
  weekly_gpu_quota_h: number;
  week_reset_day: number;
  remaining_override_h: number | null;
  override_set_at: string | null;
  disabled: number;
  created_at: string;
  updated_at: string;
  // Real accelerator quota snapshot from POST /api/v1/kernels/quota.
  quota_used_h: number;
  quota_reserved_h: number;
  quota_total_h: number | null;
  quota_refresh_at: string | null;
  quota_source: string | null; // 'api' | 'local' | 'override'
}

export interface QuotaSnapshot {
  usedHours: number;
  reservedHours: number;
  totalHours: number;
  refreshAt: string | null;
  source: "api" | "local";
}

export interface KaggleSessionRow {
  id: number;
  account_id: number;
  slug: string;
  label: string;
  type: string;
  status: string;
  status_detail: string;
  status_changed_at: string | null;
  running_since: string | null;
  last_checked_at: string | null;
  dead: number;
  dead_at: string | null;
  paused: number;
  auto_switch: number;
  plexus_url: string;
  plexus_status: string;
  plexus_error: string;
  created_at: string;
  updated_at: string;
}

export async function getAccount(id: number): Promise<KaggleAccountRow | null> {
  return byId<KaggleAccountRow>("kaggle_accounts", id);
}

export async function getSession(id: number): Promise<KaggleSessionRow | null> {
  return byId<KaggleSessionRow>("kaggle_sessions", id);
}

export function accountApiKey(account: KaggleAccountRow): string {
  return decrypt(account.api_key_enc);
}

export function accountRefreshToken(account: KaggleAccountRow): string {
  if (!account.refresh_token_enc) return "";
  const t = decrypt(account.refresh_token_enc);
  return t.startsWith("KGRT_") ? t : "";
}

const TOKEN_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

async function refreshKaggleToken(account: KaggleAccountRow): Promise<boolean> {
  const refresh = accountRefreshToken(account);
  if (!refresh) return false;
  const cooldown = await getSetting("kaggle_refresh_at_" + account.id);
  if (cooldown && Date.now() - Date.parse(cooldown) < TOKEN_REFRESH_COOLDOWN_MS) return false;
  await setSetting("kaggle_refresh_at_" + account.id, new Date().toISOString());
  try {
    const res = await fetch(`${KAGGLE_API_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return false;
    const j = await res.json();
    const access = j?.access_token;
    if (!access || access === accountApiKey(account)) return false;
    await updateRow("kaggle_accounts", account.id, {
      api_key_enc: encrypt(access),
      updated_at: nowSql(),
    });
    return true;
  } catch {
    return false;
  }
}

async function kaggleRequest(
  account: KaggleAccountRow,
  path: string,
  body?: unknown
): Promise<any> {
  const method = body === undefined ? "GET" : "POST";
  const run = async (token: string): Promise<Response> => {
    const bearer = token.startsWith("KGAT_");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    headers.Authorization = bearer
      ? `Bearer ${token}`
      : `Basic ${Buffer.from(`${account.username}:${token}`).toString("base64")}`;
    return fetch(`${KAGGLE_API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  };

  let res = await run(accountApiKey(account));
  if (res.status === 401 || res.status === 403) {
    const refreshed = await refreshKaggleToken(account);
    if (refreshed) res = await run(accountApiKey(account));
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j?.error?.message || j?.message || j?.error || "";
    } catch {
      /* ignore */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Kaggle auth failed (${res.status}) for ${account.username}`);
    }
    if (res.status === 429) throw new Error("Kaggle rate limited (429)");
    throw new Error(`Kaggle API HTTP ${res.status}${detail ? ": " + detail : ""}`);
  }
  return res.json();
}

async function kagglePost(account: KaggleAccountRow, path: string, body: unknown): Promise<any> {
  return kaggleRequest(account, path, body);
}

async function kaggleGet(account: KaggleAccountRow, path: string): Promise<any> {
  return kaggleRequest(account, path);
}

// ---------------------------------------------------------------------------
// Real accelerator quota (GET /api/v1/kernels/quota)
// ---------------------------------------------------------------------------
function quotaSeconds(value: unknown): number {
  if (value && typeof value === "object") {
    const o = value as Record<string, number>;
    const secs = o.seconds;
    if (typeof secs === "number" && Number.isFinite(secs)) {
      const nanos = typeof o.nanos === "number" && Number.isFinite(o.nanos) ? o.nanos : 0;
      return Math.max(0, secs + nanos / 1e9);
    }
    if (Object.prototype.hasOwnProperty.call(o, "seconds")) return Math.max(0, secs || 0);
    if (Object.prototype.hasOwnProperty.call(o, "timeUsed")) {
      return quotaSeconds(o.timeUsed);
    }
    if (Object.prototype.hasOwnProperty.call(o, "value")) return quotaSeconds(o.value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (!s || s === "null") return 0;
    if (s.endsWith("s")) return Math.max(0, parseFloat(s) || 0);
    if (s.endsWith("h")) return Math.max(0, (parseFloat(s) || 0) * 3600);
    return Math.max(0, parseFloat(s) || 0);
  }
  return 0;
}

const QUOTA_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;
const QUOTA_FRESH_MS = 12 * 60 * 60 * 1000;

export async function fetchQuota(account: KaggleAccountRow): Promise<{
  usedHours: number;
  reservedHours: number;
  totalHours: number;
  refreshAt: string | null;
}> {
  const j = await kaggleGet(account, "/kernels/quota");
  const g = j?.gpuQuota ?? j?.gpu_quota ?? j?.gpu ?? null;
  const rawRefresh = j?.quotaRefreshTime ?? j?.quota_refresh_time ?? null;
  const refreshAt = rawRefresh ? new Date(rawRefresh as string).toISOString() : null;
  return {
    usedHours: quotaSeconds(g?.timeUsedSeconds ?? g?.timeUsed ?? g?.time_used ?? 0) / 3600,
    reservedHours: quotaSeconds(g?.timeReservedSeconds ?? g?.timeReserved ?? g?.time_reserved ?? 0) / 3600,
    totalHours: quotaSeconds(g?.totalTimeAllowedSeconds ?? g?.totalTimeAllowed ?? g?.total_time_allowed ?? 0) / 3600,
    refreshAt,
  };
}

function storedQuota(account: KaggleAccountRow): QuotaSnapshot | null {
  if (account.quota_source !== "api" || !(account.quota_total_h ?? 0 > 0)) return null;
  return {
    usedHours: account.quota_used_h ?? 0,
    reservedHours: account.quota_reserved_h ?? 0,
    totalHours: account.quota_total_h ?? 0,
    refreshAt: account.quota_refresh_at,
    source: "api",
  };
}

function quotaIsFresh(account: KaggleAccountRow): boolean {
  if (!account.quota_refresh_at) return false;
  const t = Date.parse(account.quota_refresh_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < QUOTA_FRESH_MS;
}

/** Fetch + persist the real Kaggle accelerator quota for one account. */
export async function refreshAccountQuota(
  accountId: number,
  force = false
): Promise<QuotaSnapshot | null> {
  const account = await getAccount(accountId);
  if (!account || account.disabled) return null;

  if (!force) {
    const last = await getSetting("kaggle_quota_at_" + accountId);
    if (last && Date.now() - Date.parse(last) < QUOTA_REFRESH_COOLDOWN_MS) {
      return storedQuota(account);
    }
  }

  try {
    const q = await fetchQuota(account);
    if (!(q.totalHours > 0)) return storedQuota(account);
    await updateRow("kaggle_accounts", accountId, {
      quota_used_h: q.usedHours,
      quota_reserved_h: q.reservedHours,
      quota_total_h: q.totalHours,
      quota_refresh_at: new Date().toISOString(),
      quota_source: "api",
      updated_at: nowSql(),
    });
    await setSetting("kaggle_quota_at_" + accountId, new Date().toISOString());
    return { ...q, source: "api" };
  } catch {
    // API quota endpoint unavailable / auth failed — keep whatever we had.
    return storedQuota(account);
  }
}

/** Refresh every enabled account that is due. Never throws. */
export async function refreshAllQuotas(force = false): Promise<void> {
  const accounts = await rows<KaggleAccountRow>("kaggle_accounts", { disabled: 0 });
  for (const a of accounts) {
    try {
      await refreshAccountQuota(a.id, force);
    } catch {
      /* one failing account must not break the loop */
    }
  }
}

const STATUS_MAP: Record<string, string> = {
  running: "running",
  queued: "queued",
  complete: "complete",
  error: "error",
  failed: "error",
  cancelrequested: "stopped",
  cancelacknowledged: "stopped",
  abortrequested: "stopped",
  cancelled: "stopped",
  stopped: "stopped",
};

// Kaggle /kernels/status and /kernels/pull are GET endpoints that take the
// kernel ref split into userName + kernelSlug query params. Stored slugs
// sometimes carry a "/code/" URL prefix (from the push response ref) or a
// trailing version — normalize first so API calls never 404 on the path.
export function kernelRefParts(raw: string): { userName: string; kernelSlug: string } {
  let s = String(raw || "").trim();
  s = s.replace(/^https?:\/\/[^/]+/, "");
  s = s.replace(/^\/?code\//, "");
  s = s.replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
  const userName = parts[0] || "";
  const kernelSlug = parts.slice(1).join("/") || "";
  return { userName, kernelSlug };
}

export async function kernelStatus(account: KaggleAccountRow, slug: string): Promise<string> {
  const { userName, kernelSlug } = kernelRefParts(slug);
  const q = new URLSearchParams({ userName, kernelSlug }).toString();
  const j = await kaggleGet(account, `/kernels/status?${q}`);
  return STATUS_MAP[String(j?.status || "").toLowerCase()] || "unknown";
}

interface PulledKernel {
  metadata: Record<string, any>;
  text: string;
}

export async function pullKernel(account: KaggleAccountRow, slug: string): Promise<PulledKernel> {
  const { userName, kernelSlug } = kernelRefParts(slug);
  const q = new URLSearchParams({ userName, kernelSlug }).toString();
  const j = await kaggleGet(account, `/kernels/pull?${q}`);
  const metadata = j?.metadata ?? {};
  const notebook = j?.newNotebook ?? j?.notebook ?? {};
  let text = "";
  if (typeof notebook?.ipynb === "object") text = JSON.stringify(notebook.ipynb);
  else if (typeof notebook?.script === "string") text = notebook.script;
  else if (typeof notebook?.text === "string") text = notebook.text;
  else if (typeof j?.blob?.source === "string") text = j.blob.source;
  if (!text) throw new Error("pulled kernel has no code content");
  return { metadata, text };
}

export async function pushKernel(
  account: KaggleAccountRow,
  pulled: PulledKernel,
  slugName: string,
  newTitle?: string
): Promise<any> {
  const m = pulled.metadata;
  const has = (a: any) => Array.isArray(a) ? a : [];
  const toDataSource = (sources: any) =>
    has(sources).map((c: string) =>
      c.includes("/") ? { ref: c } : { ref: `${account.username}/${c}` }
    );
  const kernelType = (m.kernel_type || m.kernelType || m.kernelTypeNullable || "notebook")
    .toString().toLowerCase();
  const request: Record<string, any> = {
    id: m.id ?? null,
    slug: slugName,
    newTitle:
      newTitle ||
      m.title ||
      (kernelType === "notebook" ? slugName.split("-").join(" ") : m.slug || slugName),
    text: pulled.text,
    language: (m.language || m.languageNullable || "python").toString().toLowerCase(),
    kernelType,
    isPrivate: m.is_private ?? m.isPrivate ?? m.isPrivateNullable ?? true,
    enableGpu: m.enable_gpu ?? m.enableGpu ?? m.enableGpuNullable ?? true,
    enableInternet: m.enable_internet ?? m.enableInternet ?? m.enableInternetNullable ?? true,
    enableTpu: m.enable_tpu ?? m.enableTpu ?? m.enableTpuNullable ?? false,
    competitionDataSources: toDataSource(m.competition_sources ?? m.competitionDataSources),
    datasetDataSources: toDataSource(m.dataset_sources ?? m.datasetDataSources),
    notebookDataSources: toDataSource(m.kernels_sources ?? m.kernelDataSources),
    userKeywords: m.user_keywords || [],
    categoryIds: Array.isArray(m.category_ids)
      ? m.category_ids
      : typeof m.categoryIds === "string"
      ? m.categoryIds.split(",").filter(Boolean)
      : m.categoryIds ?? [],
  };
  return kagglePost(account, "/kernels/push", request);
}

// ---------------------------------------------------------------------------
// Starting a Plexus session from the bundled notebook
// ---------------------------------------------------------------------------
export interface CreateKernelFromScriptOptions {
  slugName: string;
  title?: string;
  enableGpu?: boolean;
  enableInternet?: boolean;
}

export async function createKernelFromScript(
  account: KaggleAccountRow,
  script: string,
  opts: CreateKernelFromScriptOptions
): Promise<any> {
  const request: Record<string, any> = {
    id: null,
    slug: `${account.username}/${opts.slugName}`,
    newTitle: opts.title || opts.slugName.split("-").join(" "),
    text: script,
    language: "python",
    kernelType: "script",
    isPrivate: true,
    enableGpu: opts.enableGpu ?? true,
    enableInternet: opts.enableInternet ?? true,
    enableTpu: false,
    competitionDataSources: [],
    datasetDataSources: [],
    notebookDataSources: [],
    userKeywords: [],
    categoryIds: [],
  };
  return kagglePost(account, "/kernels/push", request);
}

export interface StartPlexusSessionOptions {
  label?: string;
  slugName?: string;
  title?: string;
  brainModel?: string;
  visionModel?: string;
}

/**
 * Push the bundled Plexus bootstrap (+ Supabase keep-alive) to the account and
 * start a watched session. Re-uses an existing plexus row for the same
 * account+slug instead of creating duplicates whenever possible.
 */
export async function startPlexusSession(
  accountId: number,
  opts: StartPlexusSessionOptions = {}
): Promise<{ ok: boolean; id?: number; slug?: string; error?: string }> {
  const account = await getAccount(accountId);
  if (!account) return { ok: false, error: "account not found" };
  if (account.disabled) return { ok: false, error: "account is disabled" };

  const remaining = await gpuRemainingHours(account);
  const threshold = parseFloat((await getSetting("plexus_switch_threshold_h")) || "1.5");
  if (remaining <= threshold) {
    return {
      ok: false,
      error: `Account ${account.username} is near exhaustion (${remaining.toFixed(2)}h GPU left). Switch or pick another account first.`,
    };
  }

  const slugName =
    (opts.slugName || DEFAULT_SLUG)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || DEFAULT_SLUG;

  // Re-use an existing (not dead) plexus row for this account+slug.
  const fullSlug = `${account.username}/${slugName}`;
  const existing = await row<{ id: number }>("kaggle_sessions", {
    account_id: accountId,
    slug: fullSlug,
    type: "plexus",
    paused: 0,
    dead: 0,
  });
  if (existing) {
    return { ok: true, id: existing.id, slug: fullSlug, error: "already running" };
  }

  const [
    supabaseUrlRaw,
    supabaseKeyRaw,
    plexusTokenRaw,
    brainModelRaw,
    visionModelRaw,
  ] = await Promise.all([
    getSetting("plexus_supabase_url"),
    getSetting("plexus_supabase_key"),
    getSetting("plexus_token"),
    getSetting("plexus_brain_model"),
    getSetting("plexus_vision_model"),
  ]);
  const supabaseUrl = supabaseUrlRaw || "";
  const supabaseKey = supabaseKeyRaw || "";
  const plexusToken = plexusTokenRaw || "PLEXUS_KAGGLE_2026";
  const brainModel = brainModelRaw || DEFAULT_BRAIN_MODEL;
  const visionModel = visionModelRaw || DEFAULT_VISION_MODEL;

  const script = renderPlexusNotebook({
    supabaseUrl,
    supabaseKey,
    plexusToken,
    brainModel: opts.brainModel || brainModel,
    visionModel: opts.visionModel || visionModel,
  });

  try {
    const pushed = await createKernelFromScript(account, script, {
      slugName,
      title: opts.title || "Plexus Ollama GPU Server",
    });
    const slug = pushed?.ref || fullSlug;
    const now = iso(new Date());
    const inserted = await insertRow<KaggleSessionRow>("kaggle_sessions", {
      account_id: accountId,
      slug,
      label: (opts.label || "Plexus GPU server").slice(0, 200),
      type: "plexus",
      status: "queued",
      status_changed_at: now,
      auto_switch: 1,
    });
    const id = Number(inserted.id);
    await eventLog(id, accountId, "", "queued", `started via push (${slug})`);
    return { ok: true, id, slug };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// GPU hours accounting
// ---------------------------------------------------------------------------
export async function addGpuSeconds(accountId: number, seconds: number, tz?: string, resetDay?: number): Promise<void> {
  const account = await getAccount(accountId);
  if (!account || !(seconds > 0)) return;
  const zone = tz ?? (await timezone());
  const reset = resetDay ?? account.week_reset_day;
  const wk = weekStartKey(zone, reset);
  const prev = await row<{ seconds_run: number }>("gpu_usage_weekly", {
    account_id: accountId,
    week_start: wk,
  });
  await upsertRows(
    "gpu_usage_weekly",
    [{ account_id: accountId, week_start: wk, seconds_run: (prev?.seconds_run ?? 0) + seconds }],
    "account_id,week_start"
  );
}

export async function gpuUsedSecondsThisWeek(accountId: number, tz?: string, resetDay?: number): Promise<number> {
  const account = await getAccount(accountId);
  if (!account) return 0;
  const zone = tz ?? (await timezone());
  const reset = resetDay ?? account.week_reset_day;
  const wk = weekStartKey(zone, reset);
  const rowsArr = await rows<{ seconds_run: number }>("gpu_usage_weekly", {
    account_id: accountId,
    week_start: wk,
  });
  return rowsArr.reduce((s, r) => s + (r.seconds_run ?? 0), 0);
}

export async function gpuUsedHoursThisWeek(accountId: number): Promise<number> {
  return (await gpuUsedSecondsThisWeek(accountId)) / 3600;
}

export async function gpuRemainingHours(account: KaggleAccountRow): Promise<number> {
  if (account.remaining_override_h !== null && account.remaining_override_h !== undefined) {
    return Math.max(0, account.remaining_override_h);
  }
  const q = storedQuota(account);
  if (q && quotaIsFresh(account)) {
    // Real Kaggle numbers: total − used − reserved (a running session reserves quota).
    return Math.max(0, q.totalHours - q.usedHours - q.reservedHours);
  }
  return Math.max(0, account.weekly_gpu_quota_h - (await gpuUsedHoursThisWeek(account.id)));
}

/** Local-tracked usage (still used for the weekly history chart). */
export function quotaSnapshotFor(account: KaggleAccountRow): QuotaSnapshot | null {
  return storedQuota(account);
}

export interface GpuWeekBucket {
  weekStart: string;
  hours: number;
}

export async function weeklyGpuHistory(accountId: number, n = 8): Promise<GpuWeekBucket[]> {
  const account = await getAccount(accountId);
  if (!account) return [];
  const zone = await timezone();
  const reset = account.week_reset_day;
  const cur = weekStartKey(zone, reset);
  const starts: string[] = [cur];
  let prev = cur;
  for (let i = 1; i < n; i++) {
    const [y, m, d] = prev.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d - 7));
    prev = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    starts.push(prev);
  }
  const rowsArr = await rows<{ week_start: string; seconds_run: number }>("gpu_usage_weekly", {
    account_id: accountId,
  });
  return starts
    .map((weekStart) => {
      const s = rowsArr.filter((r) => r.week_start === weekStart).reduce((sum, r) => sum + (r.seconds_run ?? 0), 0);
      return { weekStart, hours: Math.round((s / 3600) * 10) / 10 };
    })
    .reverse();
}

// ---------------------------------------------------------------------------
// Plexus endpoint (tunnel URL published to Supabase)
// ---------------------------------------------------------------------------
export async function fetchPlexusUrl(): Promise<string | null> {
  const [url, key] = await Promise.all([getSetting("plexus_supabase_url"), getSetting("plexus_supabase_key")]);
  if (!url) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/plexus_endpoint?id=eq.1&select=public_url`,
      {
        headers: {
          apikey: key ?? "",
          Authorization: `Bearer ${key ?? ""}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) return null;
    const rowsResp = await res.json();
    return rowsResp?.[0]?.public_url || null;
  } catch {
    return null;
  }
}

export async function checkPlexusEndpoint(url: string): Promise<{ ok: boolean; error?: string; ms?: number }> {
  const token = (await getSetting("plexus_token")) || "PLEXUS_KAGGLE_2026";
  const started = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/tags`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    const ms = Date.now() - started;
    if (res.status >= 200 && res.status < 300) return { ok: true, ms };
    return { ok: false, error: `HTTP ${res.status}`, ms };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.name === "TimeoutError" ? "timeout" : err?.cause?.message || err?.message || "unreachable",
      ms: Date.now() - started,
    };
  }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------
function iso(d: Date): string {
  return d.toISOString();
}

async function eventLog(sessionId: number, accountId: number | null, from: string, to: string, note: string): Promise<void> {
  await insertRow("kaggle_session_events", {
    session_id: sessionId,
    account_id: accountId,
    from_status: from || null,
    to_status: to || null,
    note,
  });
}

export async function watchSession(session: KaggleSessionRow): Promise<void> {
  const account = await getAccount(session.account_id);
  if (!account || account.disabled) return;
  const now = new Date();
  const tz = await timezone();

  // --- kernel status -------------------------------------------------
  let next = session.status;
  let fetchError = "";
  try {
    next = await kernelStatus(account, session.slug);
  } catch (err: any) {
    fetchError = err?.message || "fetch failed";
  }

  if (fetchError) {
    await updateRow("kaggle_sessions", session.id, { last_checked_at: iso(now) });
    if (!session.status_detail) {
      await updateRow("kaggle_sessions", session.id, { status_detail: fetchError });
    }
    return;
  }

  const prev = session.status;
  const prevRunningSince = session.running_since;

  // GPU accounting + state transitions
  if (next === "running") {
    if (prevRunningSince) {
      const elapsed = (now.getTime() - Date.parse(prevRunningSince)) / 1000;
      await addGpuSeconds(account.id, elapsed, tz, account.week_reset_day);
    }
    await updateRow("kaggle_sessions", session.id, {
      status: "running",
      status_detail: "",
      running_since: iso(now),
      dead: 0,
      dead_at: null,
      status_changed_at: prev === "running" ? session.status_changed_at : iso(now),
      last_checked_at: iso(now),
    });
    if (prev !== "running") await eventLog(session.id, account.id, prev, "running", "session now running");
  } else {
    if (prevRunningSince) {
      const elapsed = (now.getTime() - Date.parse(prevRunningSince)) / 1000;
      await addGpuSeconds(account.id, elapsed, tz, account.week_reset_day);
      await updateRow("kaggle_sessions", session.id, { running_since: null });
    }
    if (next !== prev) {
      const died = prev === "running";
      await updateRow("kaggle_sessions", session.id, {
        status: next,
        status_changed_at: iso(now),
        dead: died ? 1 : 0,
        dead_at: died ? iso(now) : null,
        last_checked_at: iso(now),
      });
      await eventLog(session.id, account.id, prev, next, died ? `went ${next} while it was running` : "");
      if (died) {
        void sendAlert({
          kind: session.type === "plexus" ? "plexus_down" : "session_dead",
          title: `Kaggle session ${session.label || session.slug} died${session.type === "plexus" ? " (Plexus GPU server)" : ""}`,
          lines: [`Session: ${session.label || session.slug}`, `Status: running → ${next}`, `Account: ${account.username}`, `At: ${iso(now)}`],
        });
      }
    } else {
      await updateRow("kaggle_sessions", session.id, {
        last_checked_at: iso(now),
        status_detail: next === "error" ? (session.status_detail || "last run errored") : "",
      });
    }
  }

  // --- plexus endpoint check -----------------------------------------
  if (session.type === "plexus") {
    let url = session.plexus_url;
    try {
      const fresh = await fetchPlexusUrl();
      if (fresh && fresh !== url) {
        url = fresh;
        await eventLog(session.id, account.id, "", "", `tunnel URL updated → ${fresh}`);
      }
    } catch {
      /* keep last known url */
    }
    const okCheck = url ? await checkPlexusEndpoint(url) : { ok: false, error: "no tunnel URL published yet" };
    const newPlexusStatus = okCheck.ok ? "alive" : "dead";
    const prevPlexus = session.plexus_status;
    await updateRow("kaggle_sessions", session.id, {
      plexus_url: url || "",
      plexus_status: newPlexusStatus,
      plexus_error: okCheck.ok ? "" : okCheck.error || "",
    });
    if (newPlexusStatus === "dead" && prevPlexus === "alive") {
      void sendAlert({
        kind: "plexus_down",
        title: `Plexus endpoint went down${session.label ? " — " + session.label : ""}`,
        lines: [`URL: ${url}`, `Error: ${okCheck.error}`, `At: ${iso(now)}`],
      });
    }
  }
}

export async function watchKaggle(): Promise<void> {
  const sessions = await rows<KaggleSessionRow>("kaggle_sessions", { paused: 0 });
  for (const s of sessions) {
    try {
      await watchSession(s);
    } catch {
      // one failing session must not break the loop
    }
  }
}

// ---------------------------------------------------------------------------
// Account switcher (auto / manual)
// ---------------------------------------------------------------------------
async function switchThreshold(): Promise<number> {
  const t = parseFloat((await getSetting("plexus_switch_threshold_h")) || "1.5");
  return Number.isFinite(t) && t > 0 ? t : 1.5;
}

async function bestSwitchTarget(currentAccountId: number, minRemaining = 1.5): Promise<KaggleAccountRow | null> {
  const accounts = await rows<KaggleAccountRow>("kaggle_accounts", { disabled: 0 });
  let best: KaggleAccountRow | null = null;
  let bestRemaining = -1;
  for (const a of accounts) {
    if (a.id === currentAccountId) continue;
    const remaining = await gpuRemainingHours(a);
    if (remaining < minRemaining) continue;
    if (remaining > bestRemaining) {
      bestRemaining = remaining;
      best = a;
    }
  }
  return best;
}

async function switchCooledDown(sessionId: number): Promise<boolean> {
  const attemptAt = await row<{ value: string }>("settings", { key: "switch_attempt_" + sessionId });
  if (attemptAt && Date.now() - Date.parse(attemptAt.value) < 45 * 60 * 1000) return false;
  return true;
}

async function markSwitchAttempt(sessionId: number): Promise<void> {
  await upsertRows("settings", [{ key: "switch_attempt_" + sessionId, value: new Date().toISOString() }], "key");
}

async function performSwitchForSession(
  s: KaggleSessionRow,
  reason: string
): Promise<{ ok: boolean; movedTo?: string; error?: string }> {
  const account = await getAccount(s.account_id);
  if (!account) return { ok: false, error: "account missing" };
  const remaining = await gpuRemainingHours(account);
  const target = await bestSwitchTarget(account.id, await switchThreshold());
  if (!target) {
    const threshold = await switchThreshold();
    if (remaining > threshold) {
      // No other account has quota to switch to, but this one still does —
      // restart the session in place instead of leaving it dead.
      const res = await restartSession(s.id);
      if (!res.ok) {
        void sendAlert({
          kind: "session_dead",
          title: `Auto-restart failed — ${s.label || s.slug}`,
          lines: [`Error: ${res.error || "unknown"}`, `Session: ${s.label || s.slug}`],
        });
        return { ok: false, error: res.error || "restart failed" };
      }
      await eventLog(s.id, account.id, s.status, "restart", "auto-restart (no switch target, same account has quota)");
      void sendAlert({
        kind: "session_switched",
        title: `Auto-restarted ${s.label || s.slug} on the same account`,
        lines: [
          "Reason: no other account available",
          `Account: ${account.username} (${remaining.toFixed(1)}h GPU left)`,
          `New kernel: ${res.slug || s.slug}`,
          "The Plexus bootstrap will publish the new tunnel URL automatically.",
        ],
      });
      return { ok: true };
    }
    void sendAlert({
      kind: "session_dead",
      title: `No Kaggle account available to switch to — ${s.label || s.slug}`,
      lines: [`Account ${account.username} exhausted (${remaining.toFixed(1)}h left), no other account has ≥1.5h`, `Session: ${s.label || s.slug}`],
    });
    return { ok: false, error: "no target account available" };
  }

  try {
    const slugName = s.slug.split("/").pop()!;
    const pulled = await pullKernel(account, s.slug);
    await pushKernel(target, pulled, slugName);
    const newSlug = `${target.username}/${slugName}`;
    await updateRow("kaggle_sessions", s.id, {
      account_id: target.id,
      slug: newSlug,
      dead: 0,
      dead_at: null,
      running_since: null,
      status: "queued",
      status_changed_at: iso(new Date()),
    });
    await eventLog(s.id, target.id, s.status, "switched", `${reason} → ${target.username}`);
    await deleteRows("settings", { key: "switch_attempt_" + s.id });
    void sendAlert({
      kind: "session_switched",
      title: `Kaggle session switched to a fresh account — ${s.label || s.slug}`,
      lines: [
        `Reason: ${reason}`,
        `From: ${account.username} (${remaining.toFixed(1)}h GPU left)`,
        `To: ${target.username} (${(await gpuRemainingHours(target)).toFixed(1)}h GPU left)`,
        `New kernel: ${newSlug}`,
        `The Plexus bootstrap will publish the new tunnel URL automatically.`,
      ],
    });
    return { ok: true, movedTo: target.username };
  } catch (err: any) {
    void sendAlert({
      kind: "session_switched",
      title: `Could not auto-switch ${s.label || s.slug} (pull/push failed)`,
      lines: [`Error: ${err?.message || String(err)}`, `Account ${account.username} is at ${remaining.toFixed(1)}h. Check credentials and re-run manually.`],
    });
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function runAutoSwitcher(): Promise<void> {
  if ((await getSetting("plexus_auto_switch")) === "0") return;
  const threshold = await switchThreshold();
  const MIN_RUNNING_AGE_MS = 10 * 60 * 1000;

  // Phase A — sessions that already died and whose account is exhausted.
  const deadSessions = await rows<KaggleSessionRow>("kaggle_sessions", {
    paused: 0,
    dead: 1,
    auto_switch: 1,
  });

  for (const s of deadSessions) {
    const account = await getAccount(s.account_id);
    if (!account) continue;
    const remaining = await gpuRemainingHours(account);
    if (s.type !== "plexus" && remaining > threshold) continue;
    if (!(await switchCooledDown(s.id))) continue;
    await markSwitchAttempt(s.id);
    await performSwitchForSession(s, "limit-reached auto-switch");
  }

  // Phase B — plexus sessions still running but whose account has crossed the
  // GPU threshold (or exceeded it). Switch them BEFORE they die so the tunnel
  // keep-alive is never interrupted.
  const runningPlexus = await rows<KaggleSessionRow>("kaggle_sessions", {
    paused: 0,
    dead: 0,
    auto_switch: 1,
    type: "plexus",
    status: "running",
  });

  for (const s of runningPlexus) {
    const account = await getAccount(s.account_id);
    if (!account) continue;
    const remaining = await gpuRemainingHours(account);
    if (remaining > threshold) continue;
    // Don't yank a session that only just started.
    if (s.running_since && Date.now() - Date.parse(s.running_since) < MIN_RUNNING_AGE_MS) continue;
    if (!(await switchCooledDown(s.id))) continue;
    await markSwitchAttempt(s.id);
    await performSwitchForSession(s, "gpu quota crossed while running");
  }
}

// Push the current bundled Plexus notebook to an account. Used by restart and
// switch so those always deploy the latest script (pull→push could re-run an
// outdated notebook that's already on Kaggle).
async function pushBundledPlexus(
  account: KaggleAccountRow,
  slugName: string,
  title?: string
): Promise<void> {
  const [supabaseUrlRaw, supabaseKeyRaw, plexusTokenRaw, brainModelRaw, visionModelRaw] =
    await Promise.all([
      getSetting("plexus_supabase_url"),
      getSetting("plexus_supabase_key"),
      getSetting("plexus_token"),
      getSetting("plexus_brain_model"),
      getSetting("plexus_vision_model"),
    ]);
  const script = renderPlexusNotebook({
    supabaseUrl: supabaseUrlRaw || "",
    supabaseKey: supabaseKeyRaw || "",
    plexusToken: plexusTokenRaw || "PLEXUS_KAGGLE_2026",
    brainModel: brainModelRaw || DEFAULT_BRAIN_MODEL,
    visionModel: visionModelRaw || DEFAULT_VISION_MODEL,
  });
  await createKernelFromScript(account, script, {
    slugName,
    title: title || "Plexus Ollama GPU Server",
  });
}

// Manual restart (re-run on the same account).
export async function restartSession(sessionId: number): Promise<{ ok: boolean; error?: string; slug?: string }> {
  const s = await getSession(sessionId);
  if (!s) return { ok: false, error: "session not found" };
  const account = await getAccount(s.account_id);
  if (!account || account.disabled) return { ok: false, error: "account missing or disabled" };
  try {
    const slugName = s.slug.split("/").pop()!;
    if (s.type === "plexus") {
      // Repush the bundled notebook (always current code), not a
      // pull→push of whatever is already on Kaggle.
      await pushBundledPlexus(account, slugName);
    } else {
      const pulled = await pullKernel(account, s.slug);
      await pushKernel(account, pulled, slugName);
    }
    await updateRow("kaggle_sessions", sessionId, {
      status: "queued",
      status_changed_at: iso(new Date()),
      last_checked_at: iso(new Date()),
    });
    await eventLog(sessionId, account.id, s.status, "restart", "manual restart triggered via push");
    return { ok: true, slug: s.slug };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Manual switch to the account with the most remaining GPU hours.
export async function switchSessionNow(sessionId: number): Promise<{ ok: boolean; error?: string; movedTo?: string }> {
  const s = await getSession(sessionId);
  if (!s) return { ok: false, error: "session not found" };
  const account = await getAccount(s.account_id);
  if (!account) return { ok: false, error: "account missing" };
  const target = await bestSwitchTarget(account.id);
  if (!target) return { ok: false, error: "no other account with ≥1.5h GPU remaining" };
  try {
    const slugName = s.slug.split("/").pop()!;
    if (s.type === "plexus") {
      await pushBundledPlexus(target, slugName);
    } else {
      const pulled = await pullKernel(account, s.slug);
      await pushKernel(target, pulled, slugName);
    }
    const newSlug = `${target.username}/${slugName}`;
    await updateRow("kaggle_sessions", sessionId, {
      account_id: target.id,
      slug: newSlug,
      dead: 0,
      dead_at: null,
      status: "queued",
      status_changed_at: iso(new Date()),
    });
    await eventLog(sessionId, target.id, s.status, "switched", `manual switch → ${target.username}`);
    return { ok: true, movedTo: target.username };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export function sessionRunDurationMs(s: KaggleSessionRow): number | null {
  if (!s.running_since) return null;
  return Date.now() - Date.parse(s.running_since);
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export async function kaggleOverview() {
  const accounts = await rows<KaggleAccountRow>("kaggle_accounts", { disabled: 0 });
  const sessions = await rows<KaggleSessionRow>("kaggle_sessions", { paused: 0 });
  const running = sessions.filter((s) => s.status === "running").length;
  const dead = sessions.filter((s) => s.dead).length;
  let gpuUsed = 0;
  for (const a of accounts) gpuUsed += await gpuUsedHoursThisWeek(a.id);
  const gpuQuota = accounts.reduce((sum, a) => sum + a.weekly_gpu_quota_h, 0);
  let totalRemaining = 0;
  for (const a of accounts) totalRemaining += await gpuRemainingHours(a);
  return {
    accounts: accounts.length,
    sessions: sessions.length,
    running,
    dead,
    gpuUsedHours: Math.round(gpuUsed * 10) / 10,
    gpuQuotaHours: Math.round(gpuQuota * 10) / 10,
    totalRemainingHours: Math.round(totalRemaining * 10) / 10,
  };
}

export async function lastCheckOf(sessionId: number) {
  return rows("kaggle_session_events", { session_id: sessionId }, { order: "id", asc: false, limit: 10 });
}

export { tzParts, addDays };