"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Empty, PlexusBadge, Progress, Stat, StatusBadge } from "./ui";

interface Account {
  id: number;
  label: string;
  username: string;
  weekly_gpu_quota_h: number;
  week_reset_day: number;
  remaining_override_h: number | null;
  disabled: number;
  used_hours: number;
  remaining_hours: number;
  quota_used_h: number | null;
  quota_total_h: number | null;
  quota_reserved_h: number | null;
  quota_refresh_at: string | null;
  quota_source: string;
  masked_key: string;
  history: { weekStart: string; hours: number }[];
}

interface Session {
  id: number;
  account_id: number;
  slug: string;
  label: string;
  type: string;
  status: string;
  status_detail: string;
  status_changed_at: string | null;
  last_checked_at: string | null;
  running_since: string | null;
  dead: number;
  dead_at: string | null;
  paused: number;
  auto_switch: number;
  plexus_url: string;
  plexus_status: string;
  plexus_error: string;
  duration: string | null;
  account: { id: number; label: string; username: string } | null;
}

interface Overview {
  accounts: number;
  sessions: number;
  running: number;
  dead: number;
  gpuUsedHours: number;
  gpuQuotaHours: number;
  totalRemainingHours: number;
}

const WEEK_RESET_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function KaggleManager() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [showSessionForm, setShowSessionForm] = useState(false);
  const [showStartForm, setShowStartForm] = useState(false);
  const [gpuOverride, setGpuOverride] = useState<Account | null>(null);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const [ar, sr] = await Promise.all([fetch("/api/kaggle/accounts"), fetch("/api/kaggle/sessions")]);
    const aj = await ar.json();
    const sj = await sr.json();
    setAccounts(aj.accounts ?? []);
    setSessions(sj.sessions ?? []);
    setOverview(sj.overview ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3500);
  };

  const busy = (id: string) => !!busyMap[id];
  const setBusy = (id: string, v: boolean) => setBusyMap((m) => ({ ...m, [id]: v }));

  async function api(path: string, method = "POST", body?: unknown) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || "request failed");
    return j;
  }

  async function checkSession(s: Session) {
    setBusy("check-" + s.id, true);
    try {
      await api(`/api/kaggle/sessions/${s.id}/check`);
      await load();
    } catch (err: any) {
      flash(err.message);
    } finally {
      setBusy("check-" + s.id, false);
    }
  }

  async function restart(s: Session) {
    setBusy("restart-" + s.id, true);
    try {
      const j = await api(`/api/kaggle/sessions/${s.id}/restart`);
      flash(`Restarted — pushed kernel and queued a new run${j.slug ? " (" + j.slug + ")" : ""}`);
      await load();
    } catch (err: any) {
      flash("Restart failed: " + err.message);
    } finally {
      setBusy("restart-" + s.id, false);
    }
  }

  async function doSwitch(s: Session) {
    if (!confirm(`Switch "${s.label || s.slug}" to the account with the most GPU hours left?`)) return;
    setBusy("switch-" + s.id, true);
    try {
      await api(`/api/kaggle/sessions/${s.id}/switch`);
      flash("Switched to another account — kernel re-pushed.");
      await load();
    } catch (err: any) {
      flash("Switch failed: " + err.message);
    } finally {
      setBusy("switch-" + s.id, false);
    }
  }

  async function pause(s: Session) {
    setBusy("pause-" + s.id, true);
    try {
      await api(`/api/kaggle/sessions/${s.id}`, "PATCH", { paused: s.paused ? 0 : 1 });
      await load();
    } finally {
      setBusy("pause-" + s.id, false);
    }
  }

  async function removeSession(s: Session) {
    if (!confirm(`Delete session "${s.label || s.slug}"?`)) return;
    await api(`/api/kaggle/sessions/${s.id}`, "DELETE");
    await load();
  }

  async function toggleAccountDisabled(a: Account) {
    await api(`/api/kaggle/accounts/${a.id}`, "PATCH", { disabled: a.disabled ? 0 : 1 });
    await load();
  }

  async function removeAccount(a: Account) {
    if (!confirm(`Delete account "${a.label}"? Its sessions will be paused.`)) return;
    await api(`/api/kaggle/accounts/${a.id}`, "DELETE");
    await load();
  }

  async function clearOverride(a: Account) {
    await api(`/api/kaggle/accounts/${a.id}/gpu`, "POST", { clearOverride: true });
    await load();
  }

  async function refreshQuota(a: Account) {
    setBusy("quota-" + a.id, true);
    try {
      const j = await api(`/api/kaggle/accounts/${a.id}/quota`, "POST", {});
      flash(`Quota refreshed for ${a.label} — ${j?.quota?.usedHours?.toFixed(2)}h used of ${j?.quota?.totalHours?.toFixed(1)}h.`);
      await load();
    } catch (err: any) {
      flash("Quota refresh failed: " + err.message);
    } finally {
      setBusy("quota-" + a.id, false);
    }
  }

  async function setRemaining(a: Account, hours: number) {
    await api(`/api/kaggle/accounts/${a.id}/gpu`, "POST", { hours });
    setGpuOverride(null);
    flash(`Remaining GPU for ${a.label} set to ${hours}h (takes effect immediately).`);
    await load();
  }

  const totals = useMemo(() => {
    let used = 0;
    let quota = 0;
    let rem = 0;
    for (const a of accounts) {
      if (a.disabled) continue;
      used += a.used_hours;
      quota += a.weekly_gpu_quota_h;
      rem += a.remaining_hours;
    }
    return { used, quota, rem };
  }, [accounts]);

  return (
    <div className="space-y-4">
      {toast && (
        <div className="rounded-lg border border-emerald-700 bg-emerald-950/60 px-4 py-2.5 text-sm text-emerald-200">
          {toast}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-zinc-100">Kaggle Accounts & Session Watcher</h2>
<div className="flex gap-2">
          <Button variant="primary" onClick={() => setShowStartForm(true)} title="Push the bundled Plexus bootstrap to an account and start a GPU session">+ Start session</Button>
          <Button variant="secondary" onClick={() => setShowAccountForm(true)}>+ Account</Button>
          <Button variant="secondary" onClick={() => setShowSessionForm(true)}>+ Session</Button>
        </div>
      </div>

      {loading ? (
        <Empty text="Loading…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Accounts" value={accounts.filter((a) => !a.disabled).length} />
            <Stat label="GPU used / quota" value={`${totals.used.toFixed(1)} / ${totals.quota.toFixed(1)}h`} sub={`${totals.rem.toFixed(1)}h left`} />
            <Stat label="Sessions running" value={overview?.running ?? 0} tone="green" />
            <Stat label="Dead sessions" value={overview?.dead ?? 0} tone={overview?.dead ? "red" : "default"} />
          </div>

          <Card>
            <h3 className="mb-3 text-sm font-semibold text-zinc-200">Accounts & weekly GPU quota</h3>
            {accounts.length === 0 ? (
              <Empty text="No accounts yet." />
            ) : (
              <div className="space-y-3">
                {accounts.map((a) => {
                  const apiQuota = a.quota_source === "api" && a.quota_total_h != null && a.quota_total_h > 0;
                  const used = apiQuota ? (a.quota_used_h ?? 0) : a.used_hours;
                  const total = apiQuota ? (a.quota_total_h ?? a.weekly_gpu_quota_h) : a.weekly_gpu_quota_h;
                  const usedPct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
                  const max = Math.max(1, ...a.history.map((h) => h.hours));
                  return (
                    <div key={a.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 font-medium text-zinc-100">
                            {a.label}
                            {a.disabled && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">disabled</span>}
                          </div>
                          <div className="text-xs text-zinc-500">
                            @{a.username} · reset {WEEK_RESET_NAMES[a.week_reset_day]}
                            {apiQuota
                              ? ` · Kaggle API ${a.quota_used_h ?? 0}h / ${a.quota_total_h}h`
                              : ` · local estimate ${a.used_hours}h / ${a.weekly_gpu_quota_h}h`}
                            {a.remaining_override_h !== null && ` · manual override ${a.remaining_override_h}h`}
                          </div>
                        </div>
                        <div className="w-48">
                          <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-500">
                            <span>{apiQuota ? `GPU used ${used}h` : `Used ${used}h (local)`}</span>
                            <span className={usedPct >= 90 ? "text-red-400" : usedPct >= 70 ? "text-amber-300" : "text-emerald-400"}>
                              {a.remaining_hours}h left
                            </span>
                          </div>
                          <Progress pct={usedPct} />
                        </div>
                        <div className="flex gap-1.5">
                          <Button variant="secondary" disabled={busy("quota-" + a.id)} title="Fetch the real weekly GPU usage from Kaggle (POST /kernels/quota)"
                            onClick={() => refreshQuota(a)}>
                            {busy("quota-" + a.id) ? "Refreshing…" : "Refresh quota"}
                          </Button>
                          <Button variant="secondary" onClick={() => setGpuOverride(a)} title="Set remaining hours from the Kaggle settings page">
                            Set hours
                          </Button>
                          {a.remaining_override_h !== null && (
                            <Button variant="ghost" onClick={() => clearOverride(a)}>clear override</Button>
                          )}
                          <Button variant="secondary" onClick={() => toggleAccountDisabled(a)}>{a.disabled ? "Enable" : "Disable"}</Button>
                          <Button variant="danger" onClick={() => removeAccount(a)}>Delete</Button>
                        </div>
                      </div>
                      {a.history.length > 0 && (
                        <div className="mt-3">
                          <div className="mb-1 flex gap-1">
                            {a.history.map((h, i) => (
                              <div key={h.weekStart} className="flex-1">
                                <div className="flex h-10 items-end rounded-sm bg-zinc-900">
                                  <div
                                    className="w-full rounded-sm bg-emerald-600/70"
                                    style={{ height: h.hours > 0 ? Math.max(8, (h.hours / max) * 100) + "%" : 4 }}
                                  />
                                </div>
                                <p className="mt-0.5 text-center text-[9px] tabular-nums text-zinc-600">{h.hours}h</p>
                              </div>
                            ))}
                          </div>
                          <p className="text-[10px] text-zinc-600">Weekly GPU history (last {a.history.length} weeks)</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-200">Watched sessions</h3>
            {sessions.length === 0 ? (
              <Empty text="No sessions being watched yet. Add a notebook or Plexus session." />
            ) : (
              sessions.map((s) => (
                <div key={s.id} className={`rounded-xl border px-4 py-3 ${s.dead ? "border-red-800/70 bg-red-950/20" : "border-zinc-800 bg-zinc-900/40"}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-100">{s.label || s.slug}</span>
                        {s.type === "plexus" && (
                          <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-300 ring-1 ring-violet-500/30">
                            Plexus GPU server
                          </span>
                        )}
                        {s.paused ? (
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">paused</span>
                        ) : null}
                        {s.auto_switch ? (
                          <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300 ring-1 ring-sky-500/30" title="Auto-switch accounts when GPU limit is reached">
                            auto-switch
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {s.slug} · {s.account ? `${s.account.username}${s.account.label ? " (" + s.account.label + ")" : ""}` : "no account"}
                        {s.duration ? ` · running ${s.duration}` : ""}
                        {s.last_checked_at ? ` · checked ${new Date(s.last_checked_at + "Z").toLocaleTimeString()}` : ""}
                      </div>
                      {s.type === "plexus" && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                          <PlexusBadge status={s.plexus_status} />
                          {s.plexus_url && (
                            <a href={s.plexus_url} target="_blank" rel="noreferrer" className="truncate text-sky-400 hover:underline">
                              {s.plexus_url}
                            </a>
                          )}
                          {s.plexus_error && <span className="text-red-400/80">{s.plexus_error}</span>}
                        </div>
                      )}
                    </div>

                    <StatusBadge status={s.status} />
                    {s.dead ? (
                      <span className="text-xs font-medium text-red-400">
                        DEAD {s.dead_at ? new Date(s.dead_at + "Z").toLocaleString() : ""}
                      </span>
                    ) : null}

                    <div className="flex flex-wrap gap-1.5">
                      <Button variant="secondary" disabled={busy("check-" + s.id)} onClick={() => checkSession(s)}>
                        {busy("check-" + s.id) ? "Checking…" : "Check"}
                      </Button>
                      <Button variant="secondary" title="Re-run the kernel on the same account" disabled={busy("restart-" + s.id)} onClick={() => restart(s)}>
                        {busy("restart-" + s.id) ? "Restarting…" : "Restart"}
                      </Button>
                      <Button
                        variant="secondary"
                        title="Move this session to the account with the most GPU hours left"
                        disabled={busy("switch-" + s.id)}
                        onClick={() => doSwitch(s)}
                      >
                        {busy("switch-" + s.id) ? "Switching…" : "Switch account"}
                      </Button>
                      <Button variant="secondary" onClick={() => pause(s)}>{s.paused ? "Resume" : "Pause"}</Button>
                      <Button variant="danger" onClick={() => removeSession(s)}>Delete</Button>
                    </div>
                  </div>
                  {(s.status_detail || (s.type === "plexus" && s.plexus_error)) && (
                    <p className="mt-2 text-xs text-zinc-500">
                      {s.status_detail && `kernel: ${s.status_detail}`}
                      {s.type === "plexus" && s.plexus_error && ` · tunnel: ${s.plexus_error}`}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-500">
            <p className="font-medium text-zinc-400">How auto-switching works</p>
            <p className="mt-1">
              The real weekly GPU quota is fetched from Kaggle's <span className="font-mono">/kernels/quota</span> API on
              every poll (cooldown 10 min) — the remaining hours shown per account come straight from Kaggle when
              available, otherwise the watcher falls back to its local time estimate. When a Plexus session is running
              and its account crosses the switch threshold (default 1.5h left, configurable in Settings), the watcher
              pulls the kernel and re-pushes it to the account with the most hours remaining <em>before</em> it dies, so
              the tunnel keep-alive never drops. Dead sessions do the same after the fact. The new bootstrap run
              publishes the fresh tunnel URL to Supabase and this app re-reads it automatically on the next poll.
            </p>
          </div>
        </>
      )}

      {showAccountForm && (
        <AccountForm
          onClose={() => setShowAccountForm(false)}
          onSaved={async () => {
            await load();
            setShowAccountForm(false);
          }}
        />
      )}
      {showSessionForm && (
        <SessionForm
          accounts={accounts}
          onClose={() => setShowSessionForm(false)}
          onSaved={async () => {
            await load();
            setShowSessionForm(false);
          }}
        />
      )}
      {showStartForm && (
        <StartSessionForm
          accounts={accounts}
          onClose={() => setShowStartForm(false)}
          onSaved={async (msg) => {
            flash(msg);
            await load();
            setShowStartForm(false);
          }}
        />
      )}
      {gpuOverride && (
        <GpuOverrideForm account={gpuOverride} onClose={() => setGpuOverride(null)} onSave={setRemaining} />
      )}
    </div>
  );
}

function AccountForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [quota, setQuota] = useState("30");
  const [resetDay, setResetDay] = useState("0");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/kaggle/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, username, apiKey, refreshToken, weeklyGpuQuotaH: Number(quota), weekResetDay: Number(resetDay) }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error || "failed");
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add Kaggle account" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Label *"><input className={inputCls} required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. acc-1" /></Field>
        <Field label="Kaggle username *"><input className={inputCls} required value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" /></Field>
        <Field label="Kaggle access token *">
          <input type="password" autoComplete="new-password" className={inputCls} required value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="KGAT_… (Bearer) or legacy key" />
          <p className="text-[11px] text-zinc-500">KGAT_ tokens are sent as Bearer; older kaggle.json keys use username:key Basic auth.</p>
        </Field>
        <Field label="Refresh token (KGRT_ …) — optional">
          <input type="password" autoComplete="new-password" className={inputCls} value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="KGRT_… keeps the access token alive past 3h" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Weekly GPU quota (hours)"><input type="number" min="0" className={inputCls} value={quota} onChange={(e) => setQuota(e.target.value)} /></Field>
          <Field label="Week reset day">
            <select className={inputCls} value={resetDay} onChange={(e) => setResetDay(e.target.value)}>
              {WEEK_RESET_NAMES.map((n, i) => (
                <option key={n} value={i}>{n}</option>
              ))}
            </select>
          </Field>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Add account"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function SessionForm({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accountId, setAccountId] = useState(String(accounts[0]?.id ?? ""));
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState("notebook");
  const [autoSwitch, setAutoSwitch] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/kaggle/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: Number(accountId), slug, label, type, autoSwitch }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error || "failed");
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add watched session" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Account *">
          <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.filter((a) => !a.disabled).map((a) => (
              <option key={a.id} value={a.id}>{a.label} (@{a.username})</option>
            ))}
          </select>
        </Field>
        <Field label="Type">
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="notebook">Notebook</option>
            <option value="plexus">Plexus GPU server (Ollama + tunnel)</option>
          </select>
        </Field>
        <Field label="Notebook slug *">
          <input className={inputCls} required value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="owner/notebook-name" />
        </Field>
        <Field label="Label (optional)"><input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={autoSwitch} onChange={(e) => setAutoSwitch(e.target.checked)} />
          Auto-switch to another account when GPU limit is reached
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !accounts.length}>{busy ? "Saving…" : "Add session"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function StartSessionForm({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [accountId, setAccountId] = useState(String(accounts[0]?.id ?? ""));
  const [label, setLabel] = useState("");
  const [brainModel, setBrainModel] = useState("qwen3:30b");
  const [visionModel, setVisionModel] = useState("qwen2.5vl:7b");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/kaggle/sessions/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: Number(accountId),
          label,
          brainModel,
          visionModel,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error || "failed");
        return;
      }
      if (j.error === "already running") {
        onSaved(`Already running on that account (${j.slug}).`);
        return;
      }
      onSaved(`Started ${j.slug} on @${accounts.find((a) => a.id === Number(accountId))?.username ?? accountId}. The bootstrap will publish the tunnel URL to Supabase when ready.`);
    } catch (err: any) {
      setError(err.message || "request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Start a Plexus GPU session" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Account *">
          <select className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            {accounts.filter((a) => !a.disabled).map((a) => (
              <option key={a.id} value={a.id}>{a.label} (@{a.username}) — {a.remaining_hours}h GPU left</option>
            ))}
          </select>
        </Field>
        <Field label="Label (optional)"><input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Plexus GPU server" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Brain model"><input className={inputCls} value={brainModel} onChange={(e) => setBrainModel(e.target.value)} /></Field>
          <Field label="Vision model"><input className={inputCls} value={visionModel} onChange={(e) => setVisionModel(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-zinc-500">
          Pushes the bundled bootstrap (Ollama + authenticated proxy + Cloudflare tunnel + Supabase keep-alive)
          to the selected account and starts it. GPU + internet are enabled, script kernel type.
        </p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !accounts.length}>{busy ? "Starting…" : "Start session"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function GpuOverrideForm({
  account,
  onClose,
  onSave,
}: {
  account: Account;
  onClose: () => void;
  onSave: (a: Account, hours: number) => void;
}) {
  const [hours, setHours] = useState(String(account.remaining_hours));
  return (
    <Modal title={`Set remaining GPU hours — ${account.label}`} onClose={onClose}>
      <p className="text-xs text-zinc-500">
        Read the number from the Kaggle Settings → GPU page for @{account.username} and enter it here. This value
        overrides the watcher's own estimate until the weekly reset.
      </p>
      <input
        type="number"
        min="0"
        step="0.5"
        autoFocus
        className={inputCls}
        value={hours}
        onChange={(e) => setHours(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(account, Number(hours))}>Save override</Button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <div onClick={(e) => e.stopPropagation()} className="mt-10 w-full max-w-md space-y-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">{title}</h3>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-300">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500";