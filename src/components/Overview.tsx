"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Empty, ProviderBadge, Stat } from "./ui";

interface OverviewData {
  providerOptions: { id: string; label: string; color: string }[];
  keys: {
    total: number;
    alive: number;
    dead: number;
    rateLimited: number;
    unknown: number;
    tokensToday: number;
    deadKeys: { id: number; provider: string; account_name: string; last_error: string; last_checked_at: string | null }[];
  };
  kaggle: {
    accounts: number;
    sessions: number;
    running: number;
    dead: number;
    gpuUsedHours: number;
    gpuQuotaHours: number;
    totalRemainingHours: number;
  };
  accounts: { id: number; label: string; username: string; remaining: number }[];
  alerts: { level: "red" | "amber"; message: string }[];
  timezone: string;
  lastUpdated: string;
}

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const res = await fetch("/api/overview");
        const j = await res.json();
        if (alive) {
          setData(j);
          setError("");
        }
      } catch {
        if (alive) setError("Could not reach the server");
      }
    }
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!data && !error) return <Empty text="Loading overview…" />;
  if (!data) return <p className="text-sm text-red-400">{error}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">Overview</h2>
        <span className="text-xs text-zinc-600">
          tz {data.timezone} · updated {new Date(data.lastUpdated).toLocaleTimeString()}
        </span>
      </div>

      {data.alerts.length > 0 && (
        <div className="space-y-2">
          {data.alerts.map((a, i) => (
            <div
              key={i}
              className={`rounded-lg border px-4 py-2.5 text-sm ${
                a.level === "red"
                  ? "border-red-800 bg-red-950/40 text-red-200"
                  : "border-amber-800 bg-amber-950/40 text-amber-200"
              }`}
            >
              {a.level === "red" ? "🚨" : "⚠️"} {a.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <Stat label="API keys" value={data.keys.total} />
        <Stat label="Alive" value={data.keys.alive} tone="green" />
        <Stat label="Dead" value={data.keys.dead} tone={data.keys.dead ? "red" : "default"} />
        <Stat label="Rate-limited" value={data.keys.rateLimited} tone={data.keys.rateLimited ? "amber" : "default"} />
        <Stat label="Tokens today" value={data.keys.tokensToday.toLocaleString()} />
        <Stat label="Kaggle GPU left" value={`${data.kaggle.totalRemainingHours}h`} sub={`${data.kaggle.gpuUsedHours}h used of ${data.kaggle.gpuQuotaHours}h`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">Kaggle sessions</h3>
            <Link href="/kaggle" className="text-xs text-emerald-400 hover:underline">manage →</Link>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-xl font-semibold text-zinc-100">{data.kaggle.running}</p>
              <p className="text-[11px] text-zinc-500">running</p>
            </div>
            <div>
              <p className={`text-xl font-semibold ${data.kaggle.dead ? "text-red-400" : "text-zinc-100"}`}>{data.kaggle.dead}</p>
              <p className="text-[11px] text-zinc-500">dead</p>
            </div>
            <div>
              <p className="text-xl font-semibold text-zinc-100">{data.kaggle.accounts}</p>
              <p className="text-[11px] text-zinc-500">accounts</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {data.accounts.length === 0 && <span className="text-xs text-zinc-600">No accounts</span>}
            {data.accounts.map((a) => (
              <span key={a.id} className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-300" title={a.username}>
                {a.label}: <span className={a.remaining < 2 ? "text-red-400" : "text-emerald-400"}>{a.remaining}h</span>
              </span>
            ))}
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">Dead API keys</h3>
            <Link href="/keys" className="text-xs text-emerald-400 hover:underline">manage →</Link>
          </div>
          {data.keys.deadKeys.length === 0 ? (
            <p className="mt-3 text-xs text-zinc-600">No dead keys 🎉</p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {data.keys.deadKeys.map((k) => (
                <div key={k.id} className="flex items-center gap-2 rounded-md bg-zinc-950/60 px-2 py-1.5 text-xs">
                  <ProviderBadge id={k.provider} />
                  <span className="font-medium text-zinc-300">{k.account_name}</span>
                  <span className="truncate text-zinc-600">{k.last_error}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <h3 className="text-sm font-semibold text-zinc-200">Health check status</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.providerOptions.map((p) => (
              <span key={p.id} className="flex items-center gap-1.5 rounded-md bg-zinc-800/70 px-2 py-1 text-xs text-zinc-400">
                <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                {p.label}
              </span>
            ))}
            <span className="text-xs text-zinc-600">Background checker runs on a schedule — nothing here is public.</span>
          </div>
        </Card>

        <Card>
          <h3 className="text-sm font-semibold text-zinc-200">Quick actions</h3>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Link href="/keys" className="rounded-md bg-zinc-800 px-3 py-1.5 text-zinc-300 hover:bg-zinc-700">Dashboard → Keys</Link>
            <Link href="/kaggle" className="rounded-md bg-zinc-800 px-3 py-1.5 text-zinc-300 hover:bg-zinc-700">Dashboard → Kaggle</Link>
            <Link href="/settings" className="rounded-md bg-zinc-800 px-3 py-1.5 text-zinc-300 hover:bg-zinc-700">Settings</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}