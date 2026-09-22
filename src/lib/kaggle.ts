import { db, nowSql } from "./db";
import { decrypt, encrypt } from "./crypto";
import { getSetting, setSetting, timezone } from "./settings";
import { sendAlert } from "./alerts";
import { weekStartKey, tzParts } from "./usage";
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

export function getAccount(id: number): KaggleAccountRow | null {
  return (db.prepare("SELECT * FROM kaggle_accounts WHERE id = ?").get(id) as KaggleAccountRow) ?? null;
}

export function getSession(id: number): KaggleSessionRow | null {
  return (db.prepare("SELECT * FROM kaggle_sessions WHERE id = ?").get(id) as KaggleSessionRow) ?? null;
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
  const cooldown = getSetting("kaggle_refresh_at_" + account.id);
  if (cooldown && Date.now() - Date.parse(cooldown) < TOKEN_REFRESH_COOLDOWN_MS) return false;
  setSetting("kaggle_refresh_at_" + account.id, new Date().toISOString());
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
    db.prepare("UPDATE kaggle_accounts SET api_key_enc = ?, updated_at = ? WHERE id = ?").run(
      encrypt(access),
      nowSql(),
      account.id
    );
    return true;
  } catch {
    return false;
  }
}

async function kagglePost(account: KaggleAccountRow, path: string, body: unknown): Promise<any> {
  const run = async (token: string): Promise<Response> => {
    const bearer = token.startsWith("KGAT_");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    headers.Authorization = bearer
      ? `Bearer ${token}`
      : `Basic ${Buffer.from(`${account.username}:${token}`).toString("base64")}`;
    return fetch(`${KAGGLE_API_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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

// ---------------------------------------------------------------------------
// Real accelerator quota (POST /api/v1/kernels/quota)
// ---------------------------------------------------------------------------
function quotaSeconds(value: unknown): number {
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
  const j = await kagglePost(account, "/kernels/quota", {});
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
  const account = getAccount(accountId);
  if (!account || account.disabled) return null;

  if (!force) {
    const last = getSetting("kaggle_quota_at_" + accountId);
    if (last && Date.now() - Date.parse(last) < QUOTA_REFRESH_COOLDOWN_MS) {
      return storedQuota(account);
    }
  }

  try {
    const q = await fetchQuota(account);
    if (!(q.totalHours > 0)) return storedQuota(account);
    db.prepare(
      `UPDATE kaggle_accounts SET
         quota_used_h = ?, quota_reserved_h = ?, quota_total_h = ?,
         quota_refresh_at = ?, quota_source = 'api', updated_at = ?
       WHERE id = ?`
    ).run(q.usedHours, q.reservedHours, q.totalHours, new Date().toISOString(), nowSql(), accountId);
    setSetting("kaggle_quota_at_" + accountId, new Date().toISOString());
    return { ...q, source: "api" };
  } catch {
    // API quota endpoint unavailable / auth failed — keep whatever we had.
    return storedQuota(account);
  }
}

/** Refresh every enabled account that is due. Never throws. */
export async function refreshAllQuotas(force = false): Promise<void> {
  const accounts = db.prepare("SELECT * FROM kaggle_accounts WHERE disabled = 0").all() as KaggleAccountRow[];
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

export async function kernelStatus(account: KaggleAccountRow, slug: string): Promise<string> {
  const j = await kagglePost(account, "/kernels/status", { kernelId: slug });
  return STATUS_MAP[String(j?.status || "").toLowerCase()] || "unknown";
}

interface PulledKernel {
  metadata: Record<string, any>;
  text: string;
}

export async function pullKernel(account: KaggleAccountRow, slug: string): Promise<PulledKernel> {
  const j = await kagglePost(account, "/kernels/pull", { kernelId: slug });
  const metadata = j?.metadata ?? {};
  const notebook = j?.newNotebook ?? j?.notebook ?? {};
  let text = "";
  if (typeof notebook.ipynb === "object") text = JSON.stringify(notebook.ipynb);
  else if (typeof notebook.script === "string") text = notebook.script;
  else if (typeof notebook.text === "string") text = notebook.text;
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
  const toDataSource = (sources: any) =>
    (sources || []).map((c: string) =>
      c.includes("/") ? { ref: c } : { ref: `${account.username}/${c}` }
    );
  const request: Record<string, any> = {
    id: m.id ?? null,
    slug: slugName,
    newTitle: newTitle || m.title || slugName.split("-").join(" "),
    text: pulled.text,
    language: (m.language || "python").toLowerCase(),
    kernelType: (m.kernel_type || "notebook").toLowerCase(),
    isPrivate: m.is_private ?? true,
    enableGpu: m.enable_gpu ?? true,
    enableInternet: m.enable_internet ?? true,
    enableTpu: m.enable_tpu ?? false,
    competitionDataSources: toDataSource(m.competition_sources),
    datasetDataSources: toDataSource(m.dataset_sources),
    notebookDataSources: toDataSource(m.kernels_sources),
    userKeywords: m.user_keywords || [],
    categoryIds: m.category_ids ?? [],
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
  const account = getAccount(accountId);
  if (!account) return { ok: false, error: "account not found" };
  if (account.disabled) return { ok: false, error: "account is disabled" };

  const remaining = gpuRemainingHours(account);
  const threshold = parseFloat(getSetting("plexus_switch_threshold_h") || "1.5");
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
  const existing = db
    .prepare(
      `SELECT id FROM kaggle_sessions
       WHERE account_id = ? AND slug = ? AND type = 'plexus' AND paused = 0 AND dead = 0
       LIMIT 1`
    )
    .get(accountId, `${account.username}/${slugName}`) as { id: number } | undefined;
  if (existing) {
    return { ok: true, id: existing.id, slug: `${account.username}/${slugName}`, error: "already running" };
  }

  const script = renderPlexusNotebook({
    supabaseUrl: getSetting("plexus_supabase_url") || "",
    supabaseKey: getSetting("plexus_supabase_key") || "",
    plexusToken: getSetting("plexus_token") || "PLEXUS_KAGGLE_2026",
    brainModel: opts.brainModel || getSetting("plexus_brain_model") || DEFAULT_BRAIN_MODEL,
    visionModel: opts.visionModel || getSetting("plexus_vision_model") || DEFAULT_VISION_MODEL,
  });

  try {
    const pushed = await createKernelFromScript(account, script, {
      slugName,
      title: opts.title || "Plexus Ollama GPU Server",
    });
    const slug = pushed?.ref || `${account.username}/${slugName}`;
    const now = iso(new Date());
    const row = db
      .prepare(
        `INSERT INTO kaggle_sessions(account_id, slug, label, type, status, status_changed_at, auto_switch)
         VALUES(?, ?, ?, 'plexus', 'queued', ?, 1)`
      )
      .run(
        accountId,
        slug,
        (opts.label || "Plexus GPU server").slice(0, 200),
        now
      );
    const id = Number(row.lastInsertRowid);
    eventLog(id, accountId, "", "queued", `started via push (${slug})`);
    return { ok: true, id, slug };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// GPU hours accounting
// ---------------------------------------------------------------------------
export function addGpuSeconds(accountId: number, seconds: number, tz?: string, resetDay?: number): void {
  const account = getAccount(accountId);
  if (!account || !(seconds > 0)) return;
  const zone = tz ?? timezone();
  const reset = resetDay ?? account.week_reset_day;
  const wk = weekStartKey(zone, reset);
  db.prepare(
    `INSERT INTO gpu_usage_weekly(account_id, week_start, seconds_run)
     VALUES(?, ?, ?)
     ON CONFLICT(account_id, week_start) DO UPDATE SET seconds_run = seconds_run + excluded.seconds_run`
  ).run(accountId, wk, seconds);
}

export function gpuUsedSecondsThisWeek(accountId: number, tz?: string, resetDay?: number): number {
  const account = getAccount(accountId);
  if (!account) return 0;
  const zone = tz ?? timezone();
  const reset = resetDay ?? account.week_reset_day;
  const wk = weekStartKey(zone, reset);
  const r = db
    .prepare(`SELECT COALESCE(SUM(seconds_run),0) s FROM gpu_usage_weekly WHERE account_id = ? AND week_start = ?`)
    .get(accountId, wk) as { s: number };
  return r.s;
}

export function gpuUsedHoursThisWeek(accountId: number): number {
  return gpuUsedSecondsThisWeek(accountId) / 3600;
}

export function gpuRemainingHours(account: KaggleAccountRow): number {
  if (account.remaining_override_h !== null && account.remaining_override_h !== undefined) {
    return Math.max(0, account.remaining_override_h);
  }
  const q = storedQuota(account);
  if (q && quotaIsFresh(account)) {
    // Real Kaggle numbers: total − used − reserved (a running session reserves quota).
    return Math.max(0, q.totalHours - q.usedHours - q.reservedHours);
  }
  return Math.max(0, account.weekly_gpu_quota_h - gpuUsedHoursThisWeek(account.id));
}

/** Local-tracked usage (still used for the weekly history chart). */
export function quotaSnapshotFor(account: KaggleAccountRow): QuotaSnapshot | null {
  return storedQuota(account);
}

export interface GpuWeekBucket {
  weekStart: string;
  hours: number;
}

export function weeklyGpuHistory(accountId: number, n = 8): GpuWeekBucket[] {
  const account = getAccount(accountId);
  if (!account) return [];
  const zone = timezone();
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
  return starts
    .map((weekStart) => {
      const r = db
        .prepare(`SELECT COALESCE(SUM(seconds_run),0) s FROM gpu_usage_weekly WHERE account_id = ? AND week_start = ?`)
        .get(accountId, weekStart) as { s: number };
      return { weekStart, hours: Math.round((r.s / 3600) * 10) / 10 };
    })
    .reverse();
}

// ---------------------------------------------------------------------------
// Plexus endpoint (tunnel URL published to Supabase)
// ---------------------------------------------------------------------------
export async function fetchPlexusUrl(): Promise<string | null> {
  const url = getSetting("plexus_supabase_url");
  const key = getSetting("plexus_supabase_key");
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
    const rows = await res.json();
    return rows?.[0]?.public_url || null;
  } catch {
    return null;
  }
}

export async function checkPlexusEndpoint(url: string): Promise<{ ok: boolean; error?: string; ms?: number }> {
  const token = getSetting("plexus_token") || "PLEXUS_KAGGLE_2026";
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

function eventLog(sessionId: number, accountId: number | null, from: string, to: string, note: string): void {
  db.prepare(
    "INSERT INTO kaggle_session_events(session_id, account_id, from_status, to_status, note) VALUES(?, ?, ?, ?, ?)"
  ).run(sessionId, accountId, from, to, note);
}

export async function watchSession(session: KaggleSessionRow): Promise<void> {
  const account = getAccount(session.account_id);
  if (!account || account.disabled) return;
  const now = new Date();
  const tz = timezone();

  // --- kernel status -------------------------------------------------
  let next = session.status;
  let fetchError = "";
  try {
    next = await kernelStatus(account, session.slug);
  } catch (err: any) {
    fetchError = err?.message || "fetch failed";
  }

  if (fetchError) {
    db.prepare("UPDATE kaggle_sessions SET last_checked_at = ? WHERE id = ?").run(iso(now), session.id);
    if (!session.status_detail) {
      db.prepare("UPDATE kaggle_sessions SET status_detail = ? WHERE id = ?").run(fetchError, session.id);
    }
    return;
  }

  const prev = session.status;
  const prevRunningSince = session.running_since;

  // GPU accounting + state transitions
  if (next === "running") {
    if (prevRunningSince) {
      const elapsed = (now.getTime() - Date.parse(prevRunningSince)) / 1000;
      addGpuSeconds(account.id, elapsed, tz, account.week_reset_day);
    }
    db.prepare(
      `UPDATE kaggle_sessions SET
        status = 'running', status_detail = '', running_since = ?, dead = 0, dead_at = NULL,
        status_changed_at = CASE WHEN status = 'running' THEN status_changed_at ELSE ? END,
        last_checked_at = ? WHERE id = ?`
    ).run(iso(now), iso(now), iso(now), session.id);
    if (prev !== "running") eventLog(session.id, account.id, prev, "running", "session now running");
  } else {
    if (prevRunningSince) {
      const elapsed = (now.getTime() - Date.parse(prevRunningSince)) / 1000;
      addGpuSeconds(account.id, elapsed, tz, account.week_reset_day);
      db.prepare("UPDATE kaggle_sessions SET running_since = NULL WHERE id = ?").run(session.id);
    }
    if (next !== prev) {
      const died = prev === "running";
      db.prepare(
        `UPDATE kaggle_sessions SET
          status = ?, status_changed_at = ?, dead = ?, dead_at = ?, last_checked_at = ?
          WHERE id = ?`
      ).run(next, iso(now), died ? 1 : 0, died ? iso(now) : null, iso(now), session.id);
      eventLog(session.id, account.id, prev, next, died ? `went ${next} while it was running` : "");
      if (died) {
        void sendAlert({
          kind: session.type === "plexus" ? "plexus_down" : "session_dead",
          title: `Kaggle session ${session.label || session.slug} died${session.type === "plexus" ? " (Plexus GPU server)" : ""}`,
          lines: [`Session: ${session.label || session.slug}`, `Status: running → ${next}`, `Account: ${account.username}`, `At: ${iso(now)}`],
        });
      }
    } else {
      db.prepare("UPDATE kaggle_sessions SET last_checked_at = ?, status_detail = ? WHERE id = ?").run(iso(now), next === "error" ? (session.status_detail || "last run errored") : "", session.id);
    }
  }

  // --- plexus endpoint check -----------------------------------------
  if (session.type === "plexus") {
    let url = session.plexus_url;
    try {
      const fresh = await fetchPlexusUrl();
      if (fresh && fresh !== url) {
        url = fresh;
        eventLog(session.id, account.id, "", "", `tunnel URL updated → ${fresh}`);
      }
    } catch {
      /* keep last known url */
    }
    const okCheck = url ? await checkPlexusEndpoint(url) : { ok: false, error: "no tunnel URL published yet" };
    const newPlexusStatus = okCheck.ok ? "alive" : "dead";
    const prevPlexus = session.plexus_status;
    db.prepare(
      "UPDATE kaggle_sessions SET plexus_url = ?, plexus_status = ?, plexus_error = ? WHERE id = ?"
    ).run(url || "", newPlexusStatus, okCheck.ok ? "" : okCheck.error || "", session.id);
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
  const sessions = db
    .prepare("SELECT * FROM kaggle_sessions WHERE paused = 0")
    .all() as KaggleSessionRow[];
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
function switchThreshold(): number {
  const t = parseFloat(getSetting("plexus_switch_threshold_h") || "1.5");
  return Number.isFinite(t) && t > 0 ? t : 1.5;
}

function bestSwitchTarget(currentAccountId: number, minRemaining = 1.5): KaggleAccountRow | null {
  const accounts = db
    .prepare("SELECT * FROM kaggle_accounts WHERE disabled = 0")
    .all() as KaggleAccountRow[];
  let best: KaggleAccountRow | null = null;
  for (const a of accounts) {
    if (a.id === currentAccountId) continue;
    const remaining = gpuRemainingHours(a);
    if (remaining < minRemaining) continue;
    if (!best || gpuRemainingHours(a) > gpuRemainingHours(best)) best = a;
  }
  return best;
}

function switchCooledDown(sessionId: number): boolean {
  const attemptAt = db
    .prepare("SELECT value FROM settings WHERE key = 'switch_attempt_" + sessionId + "'")
    .get() as { value: string } | undefined;
  if (attemptAt && Date.now() - Date.parse(attemptAt.value) < 45 * 60 * 1000) return false;
  return true;
}

function markSwitchAttempt(sessionId: number): void {
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("switch_attempt_" + sessionId, new Date().toISOString());
}

async function performSwitchForSession(
  s: KaggleSessionRow,
  reason: string
): Promise<{ ok: boolean; movedTo?: string; error?: string }> {
  const account = getAccount(s.account_id);
  if (!account) return { ok: false, error: "account missing" };
  const remaining = gpuRemainingHours(account);
  const target = bestSwitchTarget(account.id, switchThreshold());
  if (!target) {
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
    db.prepare(
      `UPDATE kaggle_sessions SET
        account_id = ?, slug = ?, dead = 0, dead_at = NULL, running_since = NULL,
        status = 'queued', status_changed_at = ?
       WHERE id = ?`
    ).run(target.id, newSlug, iso(new Date()), s.id);
    eventLog(s.id, target.id, s.status, "switched", `${reason} → ${target.username}`);
    db.prepare("DELETE FROM settings WHERE key = ?").run("switch_attempt_" + s.id);
    void sendAlert({
      kind: "session_switched",
      title: `Kaggle session switched to a fresh account — ${s.label || s.slug}`,
      lines: [
        `Reason: ${reason}`,
        `From: ${account.username} (${remaining.toFixed(1)}h GPU left)`,
        `To: ${target.username} (${gpuRemainingHours(target).toFixed(1)}h GPU left)`,
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
  if (getSetting("plexus_auto_switch") === "0") return;
  const threshold = switchThreshold();
  const MIN_RUNNING_AGE_MS = 10 * 60 * 1000;

  // Phase A — sessions that already died and whose account is exhausted.
  const deadSessions = db
    .prepare("SELECT * FROM kaggle_sessions WHERE paused = 0 AND dead = 1 AND auto_switch = 1")
    .all() as KaggleSessionRow[];

  for (const s of deadSessions) {
    const account = getAccount(s.account_id);
    if (!account) continue;
    const remaining = gpuRemainingHours(account);
    if (s.type !== "plexus" && remaining > threshold) continue;
    if (!switchCooledDown(s.id)) continue;
    markSwitchAttempt(s.id);
    await performSwitchForSession(s, "limit-reached auto-switch");
  }

  // Phase B — plexus sessions still running but whose account has crossed the
  // GPU threshold (or exceeded it). Switch them BEFORE they die so the tunnel
  // keep-alive is never interrupted.
  const runningPlexus = db
    .prepare(
      `SELECT * FROM kaggle_sessions
       WHERE paused = 0 AND dead = 0 AND auto_switch = 1
         AND type = 'plexus' AND status = 'running'`
    )
    .all() as KaggleSessionRow[];

  for (const s of runningPlexus) {
    const account = getAccount(s.account_id);
    if (!account) continue;
    const remaining = gpuRemainingHours(account);
    if (remaining > threshold) continue;
    // Don't yank a session that only just started.
    if (s.running_since && Date.now() - Date.parse(s.running_since) < MIN_RUNNING_AGE_MS) continue;
    if (!switchCooledDown(s.id)) continue;
    markSwitchAttempt(s.id);
    await performSwitchForSession(s, "gpu quota crossed while running");
  }
}

// Manual restart (re-run on the same account).
export async function restartSession(sessionId: number): Promise<{ ok: boolean; error?: string; slug?: string }> {
  const s = getSession(sessionId);
  if (!s) return { ok: false, error: "session not found" };
  const account = getAccount(s.account_id);
  if (!account || account.disabled) return { ok: false, error: "account missing or disabled" };
  try {
    const slugName = s.slug.split("/").pop()!;
    const pulled = await pullKernel(account, s.slug);
    await pushKernel(account, pulled, slugName);
    db.prepare(
      "UPDATE kaggle_sessions SET status = 'queued', status_changed_at = ?, last_checked_at = ? WHERE id = ?"
    ).run(iso(new Date()), iso(new Date()), sessionId);
    eventLog(sessionId, account.id, s.status, "restart", "manual restart triggered via push");
    return { ok: true, slug: s.slug };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Manual switch to the account with the most remaining GPU hours.
export async function switchSessionNow(sessionId: number): Promise<{ ok: boolean; error?: string; movedTo?: string }> {
  const s = getSession(sessionId);
  if (!s) return { ok: false, error: "session not found" };
  const account = getAccount(s.account_id);
  if (!account) return { ok: false, error: "account missing" };
  const target = bestSwitchTarget(account.id);
  if (!target) return { ok: false, error: "no other account with ≥1.5h GPU remaining" };
  try {
    const slugName = s.slug.split("/").pop()!;
    const pulled = await pullKernel(account, s.slug);
    await pushKernel(target, pulled, slugName);
    const newSlug = `${target.username}/${slugName}`;
    db.prepare(
      "UPDATE kaggle_sessions SET account_id = ?, slug = ?, dead = 0, dead_at = NULL, status = 'queued', status_changed_at = ? WHERE id = ?"
    ).run(target.id, newSlug, iso(new Date()), sessionId);
    eventLog(sessionId, target.id, s.status, "switched", `manual switch → ${target.username}`);
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

export function kaggleOverview() {
  const accounts = db.prepare("SELECT * FROM kaggle_accounts WHERE disabled = 0").all() as KaggleAccountRow[];
  const sessions = db.prepare("SELECT * FROM kaggle_sessions WHERE paused = 0").all() as KaggleSessionRow[];
  const running = sessions.filter((s) => s.status === "running").length;
  const dead = sessions.filter((s) => s.dead).length;
  const gpuUsed = accounts.reduce((sum, a) => sum + gpuUsedHoursThisWeek(a.id), 0);
  const gpuQuota = accounts.reduce((sum, a) => sum + a.weekly_gpu_quota_h, 0);
  return {
    accounts: accounts.length,
    sessions: sessions.length,
    running,
    dead,
    gpuUsedHours: Math.round(gpuUsed * 10) / 10,
    gpuQuotaHours: Math.round(gpuQuota * 10) / 10,
    totalRemainingHours: Math.round(accounts.reduce((sum, a) => sum + gpuRemainingHours(a), 0) * 10) / 10,
  };
}

export function lastCheckOf(sessionId: number) {
  return db
    .prepare("SELECT * FROM kaggle_session_events WHERE session_id = ? ORDER BY id DESC LIMIT 10")
    .all(sessionId);
}

export { tzParts };