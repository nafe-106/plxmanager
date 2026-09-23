"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Empty, ProviderBadge, StatusBadge, Progress, Stat, formatTs } from "./ui";
import BusyChart from "./BusyChart";
import GeneralKeysPanel from "./GeneralKeysPanel";
import { PROVIDERS, GROQ_DEFAULT_MODELS } from "@/lib/providers";

interface Usage {
  hitsToday: number;
  hitsWeek: number;
  hitsAll: number;
  tokensAll: number;
  tokensToday: number;
  used: number;
  limit: number;
  provider_usage: number | null;
  provider_limit: number | null;
  primaryUsed: number;
  primaryLimit: number;
  pct: number;
  limitLeft: number;
  busyHour: number | null;
}

interface ModelUsage {
  id: number;
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

interface KeyRecord {
  id: number;
  provider: string;
  account_name: string;
  account_email: string;
  base_url: string;
  usage_limit: number;
  usage_period: string;
  usage_hour: number;
  provider_mask: string;
  disabled: number;
  status: string;
  status_detail: string;
  last_checked_at: string | null;
  last_error: string;
  usage: Usage;
  models?: ModelUsage[];
}

interface CheckRow {
  id: number;
  status: string;
  error: string | null;
  response_ms: number | null;
  ratelimit: string | null;
  check_at: string;
}

const PERIODS = ["daily", "monthly", "total"];

interface ModelDraft {
  model: string;
  tokenLimit: number;
  period: string;
  usageHour: number;
  rpm: number;
  rpd: number;
  tpm: number;
  enabled: boolean;
}

function groqDefaults(): ModelDraft[] {
  return GROQ_DEFAULT_MODELS.map((m, i) => ({
    model: m.model,
    tokenLimit: m.tpd,
    period: "daily",
    usageHour: 0,
    rpm: m.rpm,
    rpd: m.rpd,
    tpm: m.tpm,
    enabled: i < 4,
  }));
}

// Accepts either an array of models or `{ models: [...] }`, and each entry
// can use long names (tpd/rpd/rpm/tpm) or form names (tokenLimit/...).
function parseModelsJson(text: string): { models: ModelDraft[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { models: [], error: "Invalid JSON: " + (e as Error).message };
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.models)
      ? (parsed as any).models
      : null;
  if (!arr) return { models: [], error: "Expected an array of models, or { models: [...] }." };
  const out: ModelDraft[] = [];
  for (const raw of arr) {
    const r = raw as Record<string, unknown>;
    const model = String(r.model ?? r.name ?? "").trim();
    if (!model) continue;
    out.push({
      model,
      tokenLimit: numOf(r.tpd, r.token_limit, r.tokenLimit, r.tokensPerDay),
      period: ["daily", "weekly", "monthly", "total"].includes(String(r.period)) ? String(r.period) : "daily",
      usageHour: numOf(r.usage_hour, r.usageHour) || 0,
      rpm: numOf(r.rpm, r.requestsPerMinute),
      rpd: numOf(r.rpd, r.requestsPerDay),
      tpm: numOf(r.tpm, r.tokensPerMinute),
      enabled: r.enabled !== false,
    });
  }
  if (!out.length) return { models: [], error: "No models found in JSON (need a \"model\" name each)." };
  return { models: out };
}

function numOf(...vals: unknown[]): number {
  for (const v of vals) {
    const n = parseFloat(String(v ?? ""));
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return 0;
}

export default function KeyManager() {
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterProvider, setFilterProvider] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ key: KeyRecord; hours: number[]; checks: CheckRow[] } | null>(null);
  const [form, setForm] = useState<null | { mode: "add" | "edit"; key?: KeyRecord }>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys");
      const j = await res.json();
      setKeys(j.keys ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const active = keys.filter((k) => !k.disabled);
    return {
      total: active.length,
      alive: active.filter((k) => k.status === "alive").length,
      dead: active.filter((k) => k.status === "dead").length,
      rateLimited: active.filter((k) => k.status === "rate_limited").length,
      unknown: active.filter((k) => k.status === "unknown").length,
      tokensToday: active.reduce((s, k) => s + (k.usage?.tokensToday ?? 0), 0),
    };
  }, [keys]);

  const filtered = useMemo(() => {
    let list = [...keys];
    if (filterProvider) list = list.filter((k) => k.provider === filterProvider);
    if (filterStatus) list = list.filter((k) => k.status === filterStatus);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (k) =>
          k.account_name.toLowerCase().includes(q) ||
          (k.account_email || "").toLowerCase().includes(q) ||
          k.provider.toLowerCase().includes(q)
      );
    }
    const order: Record<string, number> = { dead: 0, rate_limited: 1, unknown: 2, alive: 3 };
    return list.sort((a, b) => {
      const da = a.disabled ? 1 : 0;
      const db_ = b.disabled ? 1 : 0;
      if (da !== db_) return da - db_;
      const sa = order[a.status] ?? 4;
      const sb = order[b.status] ?? 4;
      if (sa !== sb) return sa - sb;
      return a.account_name.localeCompare(b.account_name);
    });
  }, [keys, filterProvider, filterStatus, query]);

  async function action(fn: () => Promise<unknown>, reloadAfter: boolean) {
    try {
      await fn();
      if (reloadAfter) await load();
    } catch (err) {
      alert(String(err));
    }
  }

  async function checkNow(k: KeyRecord) {
    try {
      const res = await fetch(`/api/keys/${k.id}/check`, { method: "POST" });
      const j = await res.json();
      if (!res.ok) alert(j.error || "check failed");
      await load();
      if (openId === k.id) await openDetail(k.id);
    } catch (err) {
      alert(String(err));
    }
  }

  async function toggleDisabled(k: KeyRecord) {
    await action(
      () =>
        fetch(`/api/keys/${k.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled: k.disabled ? 0 : 1 }),
        }),
      true
    );
  }

  async function copyKey(k: KeyRecord) {
    try {
      const res = await fetch(`/api/keys/${k.id}/secret`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "failed to reveal key");
      await navigator.clipboard.writeText(j.apiKey);
      alert(`Copied ${k.account_name}'s API key to clipboard`);
    } catch (err) {
      alert(String(err));
    }
  }

  async function remove(k: KeyRecord) {
    if (!confirm(`Delete "${k.account_name}" and all its usage history?`)) return;
    await action(() => fetch(`/api/keys/${k.id}`, { method: "DELETE" }), true);
  }

  async function openDetail(id: number) {
    const res = await fetch(`/api/keys/${id}/check`);
    const j = await res.json();
    setDetail({ key: j.key, hours: j.hours, checks: j.checks });
    setOpenId(id === openId ? null : id);
  }

  function toggleRow(id: number) {
    if (id === openId) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    openDetail(id);
  }

  return (
    <div className="space-y-4">
      <GeneralKeysPanel />

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-zinc-100">API Keys</h2>
        <Button variant="primary" onClick={() => setForm({ mode: "add" })}>
          + Add key
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Total keys" value={counts.total} />
        <Stat label="Alive" value={counts.alive} tone="green" />
        <Stat label="Dead" value={counts.dead} tone={counts.dead ? "red" : "default"} />
        <Stat label="Rate-limited" value={counts.rateLimited} tone={counts.rateLimited ? "amber" : "default"} />
        <Stat label="Tokens today" value={counts.tokensToday.toLocaleString()} sub="combined" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name / email / provider…"
          className="w-full max-w-xs rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-500"
        />
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
        >
          <option value="">All statuses</option>
          <option value="alive">Alive</option>
          <option value="dead">Dead</option>
          <option value="rate_limited">Rate-limited</option>
          <option value="unknown">Unknown</option>
        </select>
        <select
          value={filterProvider}
          onChange={(e) => setFilterProvider(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
        >
          <option value="">All providers</option>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <Empty text="Loading…" />
      ) : filtered.length === 0 ? (
        <Empty text="No keys. Add one to get started." />
      ) : (
        <div className="space-y-2">
          {filtered.map((k) => (
            <KeyRow
              key={k.id}
              k={k}
              open={openId === k.id}
              detail={detail && detail.key?.id === k.id ? detail : null}
              onToggle={() => toggleRow(k.id)}
              onCheck={() => checkNow(k)}
              onEdit={() => setForm({ mode: "edit", key: k })}
              onDuplicate={() => setForm({ mode: "add", key: k })}
              onCopy={() => copyKey(k)}
              onDisable={() => toggleDisabled(k)}
              onDelete={() => remove(k)}
            />
          ))}
        </div>
      )}

      {form && (
        <KeyForm
          mode={form.mode}
          initial={form.key}
          onClose={() => setForm(null)}
          onSaved={async () => {
            await load();
            setForm(null);
          }}
        />
      )}
    </div>
  );
}

function KeyRow({
  k,
  open,
  detail,
  onToggle,
  onCheck,
  onEdit,
  onDuplicate,
  onCopy,
  onDisable,
  onDelete,
}: {
  k: KeyRecord;
  open: boolean;
  detail: { hours: number[]; checks: CheckRow[] } | null;
  onToggle: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onDisable: () => void;
  onDelete: () => void;
}) {
  const u = k.usage;
  const pct = u?.pct ?? 0;
  return (
    <div className={`rounded-xl border transition ${open ? "border-emerald-700/60 bg-zinc-900" : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"}`}>
      <div className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3" onClick={onToggle}>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-zinc-100">{k.account_name}</span>
              {k.disabled ? (
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">disabled</span>
              ) : null}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
              {k.account_email && <span className="truncate">{k.account_email}</span>}
              <span className="font-mono text-zinc-600">{k.provider_mask}</span>
            </div>
          </div>
        </div>

        <ProviderBadge id={k.provider} />
        <StatusBadge status={k.disabled ? "unknown" : k.status} />

        <div className="min-w-36 flex-1">
          <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-500">
            <span>
              {u.primaryLimit > 0
                ? `${u.primaryUsed.toLocaleString(undefined, { maximumFractionDigits: 1 })} / ${u.primaryLimit.toLocaleString(undefined, { maximumFractionDigits: 1 })}`
                : `${u.primaryUsed.toLocaleString(undefined, { maximumFractionDigits: 1 })} used`}
            </span>
            <span className={pct >= 95 ? "text-red-400" : pct >= 80 ? "text-amber-300" : "text-zinc-500"}>
              {pct.toFixed(0)}%
            </span>
          </div>
          <Progress pct={pct} />
          <div className="mt-1 flex gap-3 text-[10px] text-zinc-600">
            <span>{u?.busyHour !== null ? `busy hr ${String(u?.busyHour ?? 0).padStart(2, "0")}:00` : "no usage yet"}</span>
            <span>limit left {u?.limitLeft >= 0 ? u.limitLeft.toLocaleString() : "∞"}</span>
          </div>
        </div>

        <div className="flex items-center gap-3 text-center text-[11px] text-zinc-500">
          <div>
            <div className="font-semibold tabular-nums text-zinc-300">{u?.hitsToday ?? 0}</div>
            <div className="text-zinc-600">today</div>
          </div>
          <div>
            <div className="font-semibold tabular-nums text-zinc-300">{u?.hitsWeek ?? 0}</div>
            <div className="text-zinc-600">week</div>
          </div>
          <div>
            <div className="font-semibold tabular-nums text-zinc-300">{u?.hitsAll ?? 0}</div>
            <div className="text-zinc-600">all time</div>
          </div>
        </div>

        <span className={`text-xs text-zinc-600 ${open ? "rotate-90" : ""} transition-transform`}>▸</span>
      </div>

      {/* actions */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-800/80 px-4 py-1.5" onClick={(e) => e.stopPropagation()}>
        <Button variant="secondary" onClick={onCheck}>
          Check now
        </Button>
        <Button variant="secondary" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="secondary" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button variant="secondary" onClick={onCopy}>
          Copy key
        </Button>
        <Button variant="secondary" onClick={onDisable}>
          {k.disabled ? "Enable" : "Disable"}
        </Button>
        <Button variant="danger" onClick={onDelete}>
          Delete
        </Button>
        <span className="ml-auto break-all text-[11px] text-zinc-600">
          {k.last_checked_at ? `last checked ${formatTs(k.last_checked_at)}` : "never checked"}
          {k.status === "dead" && k.last_error ? ` · ${k.last_error}` : ""}
          {k.status_detail ? ` · rl: ${k.status_detail}` : ""}
        </span>
      </div>

      {open && detail && (
        <div className="border-t border-zinc-800/80 px-4 py-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Hits per hour (all time, local {Intl.DateTimeFormat().resolvedOptions().timeZone})
          </p>
          <BusyChart hours={detail.hours} highlight={k.usage?.busyHour ?? undefined} />
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Recent checks</p>
              {detail.checks.length === 0 ? (
                <p className="text-xs text-zinc-600">No health checks recorded yet.</p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
                  {detail.checks.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 text-xs text-zinc-400">
                      <StatusBadge status={c.status === "reached" ? "alive" : c.status} />
                      <span className="tabular-nums text-zinc-600">
                        {formatTs(c.check_at)} · {c.response_ms}ms
                      </span>
                      {c.error && <span className="truncate text-red-400/80">{c.error}</span>}
                      {c.ratelimit && <span className="truncate text-zinc-600">{c.ratelimit}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">By the numbers</p>
              <div className="space-y-1 text-xs text-zinc-400">
                <div className="flex justify-between"><span>Tokens used (period · {k.usage_period})</span><span className="tabular-nums">{u?.used.toLocaleString()}</span></div>
                <div className="flex justify-between"><span>Provider-reported usage</span><span className="tabular-nums">{u?.provider_usage ?? "—"}</span></div>
                <div className="flex justify-between"><span>Provider limit</span><span className="tabular-nums">{u?.provider_limit ?? "—"}</span></div>
                <div className="flex justify-between"><span>Configured limit</span><span className="tabular-nums">{u?.limit ?? 0}</span></div>
                <div className="flex justify-between"><span>Configured busy hour</span><span className="tabular-nums">{String(k.usage_hour).padStart(2, "0")}:00</span></div>
                <div className="flex justify-between"><span>Base URL</span><span className="max-w-40 truncate">{k.base_url || "default"}</span></div>
              </div>
            </div>
          </div>
          {k.models && k.models.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Models · per-model free-token limits
              </p>
              <div className="space-y-2">
                {k.models.map((m) => (
                  <div key={m.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs text-zinc-200">{m.model}</span>
                      <span className="text-[11px] text-zinc-500">
                        {m.enabled ? "" : "disabled · "}poll reset {String(m.usage_hour).padStart(2, "0")}:00
                      </span>
                    </div>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                      <div>
                        <div className="flex items-center justify-between text-[11px] text-zinc-500">
                          <span>TPD · tokens/day</span>
                          <span className="tabular-nums">
                            {m.tokenLimit > 0
                              ? `${m.tokensToday.toLocaleString()} / ${m.tokenLimit.toLocaleString()}`
                              : `${m.tokensToday.toLocaleString()} tok`}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <Progress pct={m.pct} />
                          <span className={`text-[11px] tabular-nums ${m.pct >= 95 ? "text-red-400" : m.pct >= 80 ? "text-amber-300" : "text-zinc-500"}`}>
                            {m.pct.toFixed(0)}%
                          </span>
                        </div>
                        {m.tokenLimit > 0 && (
                          <div className="text-[10px] text-zinc-600">left {m.limitLeft.toLocaleString()} tok</div>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center justify-between text-[11px] text-zinc-500">
                          <span>RPD · reqs/day</span>
                          <span className="tabular-nums">
                            {m.rpd > 0 ? `${m.hitsToday.toLocaleString()} / ${m.rpd.toLocaleString()}` : `${m.hitsToday} req`}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <Progress pct={m.reqPct} />
                          <span className={`text-[11px] tabular-nums ${m.reqPct >= 95 ? "text-red-400" : m.reqPct >= 80 ? "text-amber-300" : "text-zinc-500"}`}>
                            {m.reqPct.toFixed(0)}%
                          </span>
                        </div>
                        {m.rpd > 0 && (
                          <div className="text-[10px] text-zinc-600">left {m.reqLeft.toLocaleString()} req</div>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-zinc-600">
                      <span>RPM {m.rpm > 0 ? m.rpm.toLocaleString() : "—"}</span>
                      <span>TPM {m.tpm > 0 ? m.tpm.toLocaleString() : "—"}</span>
                      <span>{m.busyHour !== null ? `busy ${String(m.busyHour).padStart(2, "0")}:00` : "no usage yet"}</span>
                      <span>hits {m.hitsAll} all</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KeyForm({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  initial?: KeyRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState(initial?.provider ?? "openrouter");
  const [accountName, setAccountName] = useState(initial?.account_name ?? "");
  const [accountEmail, setAccountEmail] = useState(initial?.account_email ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [usageLimit, setUsageLimit] = useState(String(initial?.usage_limit ?? "0"));
  const [usagePeriod, setUsagePeriod] = useState(initial?.usage_period ?? "monthly");
  const [usageHour, setUsageHour] = useState(String(initial?.usage_hour ?? "9"));
  const [models, setModels] = useState<ModelDraft[]>(() =>
    initial?.models?.map((m) => ({
      model: m.model,
      tokenLimit: m.tokenLimit,
      period: m.period,
      usageHour: m.usage_hour,
      rpm: m.rpm,
      rpd: m.rpd,
      tpm: m.tpm,
      enabled: !!m.enabled,
    })) ?? []
  );
  const [modelJson, setModelJson] = useState("");
  const [modelJsonError, setModelJsonError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    if (!initial) return;
    let cancelled = false;
    fetch(`/api/keys/${initial.id}/secret`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j.apiKey) setApiKey(j.apiKey);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initial]);

  const providerDef = PROVIDERS.find((p) => p.id === provider);
  const needsBaseUrl = providerDef?.requiresBaseUrl;

  function setProviderAndMaybePrefill(p: string) {
    setProvider(p);
    if (p === "groq" && mode === "add" && models.length === 0) {
      setModels(groqDefaults());
    }
  }

  function setModelAt(i: number, patch: Partial<ModelDraft>) {
    setModels((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }

  function loadModelsJson() {
    const res = parseModelsJson(modelJson);
    setModelJsonError(res.error ?? "");
    if (!res.error && res.models.length) {
      setModels(res.models);
      setModelJson("");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = {
      provider,
      accountName,
      accountEmail,
      usageLimit: Number(usageLimit),
      usagePeriod,
      usageHour: Number(usageHour),
      baseUrl,
      models: models.filter((m) => m.model.trim()).map((m) => ({
        model: m.model.trim(),
        tokenLimit: m.tokenLimit,
        period: m.period,
        usageHour: m.usageHour,
        rpm: m.rpm,
        rpd: m.rpd,
        tpm: m.tpm,
        enabled: m.enabled,
      })),
    };
    if (mode === "edit") {
      body.accountName = accountName;
      body.accountEmail = accountEmail;
      if (apiKey.trim()) body.apiKey = apiKey.trim();
    } else {
      body.apiKey = apiKey.trim();
    }
    if (needsBaseUrl && !baseUrl.trim()) {
      setError("This provider needs a Base URL");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch(mode === "edit" ? `/api/keys/${initial!.id}` : "/api/keys", {
        method: mode === "edit" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j?.error || "Failed to save");
        return;
      }
      onSaved();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4">
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="mt-10 w-full max-w-2xl space-y-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">
            {mode === "edit" ? "Edit API key" : initial ? `Duplicate · ${initial.account_name}` : "Add API key"}
          </h3>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-300">✕</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Provider">
            <select
              value={provider}
              onChange={(e) => setProviderAndMaybePrefill(e.target.value)}
              className={inputCls}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Account name *">
            <input className={inputCls} value={accountName} onChange={(e) => setAccountName(e.target.value)} required />
          </Field>
        </div>

        <Field label="Account email">
          <input type="email" className={inputCls} value={accountEmail} onChange={(e) => setAccountEmail(e.target.value)} />
        </Field>

        <Field label={mode === "edit" ? "API key (leave blank to keep current)" : "API key *"}>
          <div className="flex gap-2">
            <input
              type={showApiKey ? "text" : "password"}
              autoComplete="new-password"
              className={inputCls}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required={mode === "add"}
              placeholder={mode === "edit" ? (apiKey ? "" : "••••••••") : "sk-…"}
            />
            <button
              type="button"
              onClick={() => setShowApiKey((s) => !s)}
              className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              {showApiKey ? "Hide" : "Show"}
            </button>
          </div>
        </Field>

        <Field label={needsBaseUrl ? "Base URL *" : "Base URL (empty = provider default)"}>
          <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Token limit">
<input
              type="number"
              min="0"
              step="any"
              className={inputCls}
              value={usageLimit}
              onChange={(e) => setUsageLimit(e.target.value)}
            />
          </Field>
          <Field label="Period">
            <select className={inputCls} value={usagePeriod} onChange={(e) => setUsagePeriod(e.target.value)}>
              {PERIODS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Usage hour (0-23)">
            <select className={inputCls} value={usageHour} onChange={(e) => setUsageHour(e.target.value)}>
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2, "0")}:00</option>
              ))}
            </select>
          </Field>
        </div>

        <datalist id="groq-model-list">
          {GROQ_DEFAULT_MODELS.map((m) => (
            <option key={m.model} value={m.model} />
          ))}
        </datalist>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500">
              Models & per-model limits
            </span>
            <button
              type="button"
              onClick={() =>
                setModels((prev) => [
                  ...prev,
                  { model: "", tokenLimit: 0, period: "daily", usageHour: 0, rpm: 0, rpd: 0, tpm: 0, enabled: true },
                ])
              }
              className="text-xs font-medium text-emerald-400 hover:text-emerald-300"
            >
              + Add model
            </button>
          </div>
          {provider === "groq" && (
            <p className="mb-2 text-[11px] text-zinc-600">
              Pre-filled with Groq's current free-tier limits (TPD/RPD/RPM/TPM) — editable.
            </p>
          )}
          {models.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-xs text-zinc-600">
              No models tracked. Record usage with a <code className="text-zinc-400">model</code> field for per-model limits.
            </p>
          ) : (
            <div className="space-y-2">
              {models.map((m, i) => (
                <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-48 flex-1">
                      <Field label="Model">
                        <input
                          className={inputCls}
                          list="groq-model-list"
                          value={m.model}
                          placeholder="e.g. llama-3.3-70b-versatile"
                          onChange={(e) => setModelAt(i, { model: e.target.value })}
                        />
                      </Field>
                    </div>
                    <div className="w-28">
                      <Field label="TPD (tok/day)">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          className={inputCls}
                          value={m.tokenLimit}
                          onChange={(e) => setModelAt(i, { tokenLimit: Number(e.target.value) || 0 })}
                        />
                      </Field>
                    </div>
                    <div className="w-24">
                      <Field label="RPD (req/day)">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          className={inputCls}
                          value={m.rpd}
                          onChange={(e) => setModelAt(i, { rpd: Number(e.target.value) || 0 })}
                        />
                      </Field>
                    </div>
                    <div className="w-20">
                      <Field label="RPM">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          className={inputCls}
                          value={m.rpm}
                          onChange={(e) => setModelAt(i, { rpm: Number(e.target.value) || 0 })}
                        />
                      </Field>
                    </div>
                    <div className="w-24">
                      <Field label="TPM">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          className={inputCls}
                          value={m.tpm}
                          onChange={(e) => setModelAt(i, { tpm: Number(e.target.value) || 0 })}
                        />
                      </Field>
                    </div>
                    <div className="w-24">
                      <Field label="Period">
                        <select
                          className={inputCls}
                          value={m.period}
                          onChange={(e) => setModelAt(i, { period: e.target.value })}
                        >
                          {["daily", "monthly", "total"].map((p) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <div className="w-20">
                      <Field label="Hr">
                        <select
                          className={inputCls}
                          value={m.usageHour}
                          onChange={(e) => setModelAt(i, { usageHour: Number(e.target.value) })}
                        >
                          {Array.from({ length: 24 }, (_, h) => (
                            <option key={h} value={h}>{String(h).padStart(2, "0")}</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <div className="flex items-center gap-2 pb-2">
                      <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                        <input
                          type="checkbox"
                          checked={m.enabled}
                          onChange={(e) => setModelAt(i, { enabled: e.target.checked })}
                          className="h-3.5 w-3.5"
                        />
                        on
                      </label>
                      <button
                        type="button"
                        onClick={() => setModels((prev) => prev.filter((_, idx) => idx !== i))}
                        className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-500 hover:border-red-500/60 hover:text-red-400"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-zinc-500">Paste model JSON</span>
              <button
                type="button"
                onClick={loadModelsJson}
                className="rounded bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
              >
                Load
              </button>
            </div>
            <p className="mt-1 text-[11px] text-zinc-600">
              Array of models with their limits. Fields: model, tpd, rpd, rpm, tpm (optionally period, usage_hour).
            </p>
            <textarea
              value={modelJson}
              onChange={(e) => setModelJson(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder='[{"model":"llama-3.3-70b-versatile","tpd":100000,"rpd":1000,"rpm":30,"tpm":12000}, {"model":"qwen/qwen3-32b","tpd":200000,"rpd":1000,"rpm":30,"tpm":8000}]'
              className="mt-1.5 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
            />
            {modelJsonError && <p className="mt-1 text-xs text-red-400">{modelJsonError}</p>}
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy} className="px-4">
            {busy ? "Saving…" : mode === "add" ? "Add key" : "Save changes"}
          </Button>
        </div>
      </form>
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