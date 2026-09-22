"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Empty } from "./ui";

interface GkRecord {
  id: number;
  name: string;
  note: string;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
  hitsAll: number;
  tokensAll: number;
  hitsToday: number;
  tokensToday: number;
  hasSecret: boolean;
}

function CopyBtn({
  text,
  label,
  variant = "ghost",
}: {
  text: string;
  label: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  const [ok, setOk] = useState(false);
  return (
    <Button
      variant={variant}
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setOk(true);
            setTimeout(() => setOk(false), 1500);
          })
          .catch(() => window.prompt("Copy manually:", text))
      }
    >
      {ok ? "Copied ✓" : label}
    </Button>
  );
}

export default function GeneralKeysPanel() {
  const [keys, setKeys] = useState<GkRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ id: number; name: string; secret: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [rotateErr, setRotateErr] = useState("");

  // Fetch (decrypt server-side) and copy the stored secret for one key.
  async function copySecret(k: GkRecord) {
    const cached = revealed[k.id];
    if (cached) {
      await navigator.clipboard.writeText(cached).catch(() => window.prompt("Copy manually:", cached));
      return;
    }
    try {
      const res = await fetch(`/api/general-keys/${k.id}/secret`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Failed to reveal secret");
      setRevealed((r) => ({ ...r, [k.id]: j.apiKey }));
      await navigator.clipboard.writeText(j.apiKey).catch(() => window.prompt("Copy manually:", j.apiKey));
    } catch (err) {
      alert((err as Error).message);
    }
  }

  // Issue a fresh tam_gk_ secret for a legacy key (usage stats are kept).
  async function rotate(k: GkRecord) {
    if (!confirm(`Regenerate the secret for "${k.name}"? Clients using the old key must be updated.`)) return;
    setRotateErr("");
    try {
      const res = await fetch(`/api/general-keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotateSecret: true }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Failed to regenerate secret");
      setRevealed((r) => ({ ...r, [k.id]: j.secret }));
      await navigator.clipboard.writeText(j.secret).catch(() => window.prompt("Copy manually:", j.secret));
      await load();
    } catch (err) {
      setRotateErr((err as Error).message);
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/general-keys");
      const j = await res.json();
      setKeys(j.keys ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/general-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Failed to create key");
      setCreated(j.key);
      setName("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(k: GkRecord) {
    await fetch(`/api/general-keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !k.enabled }),
    });
    await load();
  }

  async function remove(k: GkRecord) {
    if (!confirm(`Delete general key "${k.name}" and its usage logs?`)) return;
    await fetch(`/api/general-keys/${k.id}`, { method: "DELETE" });
    await load();
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="font-semibold text-zinc-100">General keys · OpenAI-compatible gateway</h3>
        <p className="mt-0.5 text-xs text-zinc-500">
          One key that routes through <em>all</em> your provider keys — each request goes to the least-used eligible key
          (usage-weighted round-robin). Base URL: <code className="text-zinc-400">{origin}/v1</code>{" "}
          <CopyBtn text={`${origin}/v1`} label="Copy base URL" />
        </p>
      </div>

      <form onSubmit={create} className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name (e.g. openclaw)"
          className="w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-500"
        />
        <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "+ Create general key"}
        </Button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </form>

      {created && (
        <div className="rounded-lg border border-emerald-700/60 bg-emerald-500/5 p-3 text-sm">
          <p className="font-medium text-emerald-300">
            “{created.name}” created — copy the secret now, it is shown only once:
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-zinc-950 px-2 py-1.5 font-mono text-xs text-emerald-200">
              {created.secret}
            </code>
            <CopyBtn text={created.secret} label="Copy secret" variant="secondary" />
            <CopyBtn text={`${origin}/v1`} label="Copy base URL" />
            <CopyBtn text={`Base URL: ${origin}/v1\nAPI Key: ${created.secret}`} label="Copy both" />
            <Button variant="ghost" onClick={() => setCreated(null)}>
              Dismiss
            </Button>
          </div>
          <p className="mt-2 break-all text-[11px] text-zinc-500">
            OpenClaw / OpenAI-compatible clients: base URL <code className="text-zinc-400">{origin}/v1</code> · API key{" "}
            <code className="text-zinc-400">{created.secret.slice(0, 12)}…</code>
          </p>
        </div>
      )}

      {loading ? (
        <Empty text="Loading…" />
      ) : keys.length === 0 ? (
        <Empty text="No general keys yet. Create one to expose an OpenAI-compatible endpoint over all your API keys." />
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-zinc-100">{k.name}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    k.enabled ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {k.enabled ? "enabled" : "disabled"}
                </span>
                <span className="ml-auto flex flex-wrap gap-3 text-[11px] text-zinc-500">
                  <span>
                    reqs today <b className="tabular-nums text-zinc-300">{k.hitsToday}</b>
                  </span>
                  <span>
                    tok today <b className="tabular-nums text-zinc-300">{k.tokensToday.toLocaleString()}</b>
                  </span>
                  <span>
                    reqs all <b className="tabular-nums text-zinc-300">{k.hitsAll}</b>
                  </span>
                  <span>
                    tok all <b className="tabular-nums text-zinc-300">{k.tokensAll.toLocaleString()}</b>
                  </span>
                </span>
                <div className="flex gap-1.5">
                  <Button variant="primary" onClick={() => copySecret(k)}>
                    Copy API key
                  </Button>
                  <CopyBtn text={`${origin}/v1`} label="Copy base URL" />
                  <Button variant="secondary" onClick={() => toggle(k)}>
                    {k.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="danger" onClick={() => remove(k)}>
                    Delete
                  </Button>
                  {!k.hasSecret && (
                    <Button variant="secondary" onClick={() => rotate(k)}>
                      Regenerate secret
                    </Button>
                  )}
                </div>
              </div>
              {k.note && <p className="mt-1 text-xs text-zinc-600">{k.note}</p>}
              <p className="mt-1 text-[11px] text-zinc-600">
                created {k.created_at ? new Date(k.created_at + "Z").toLocaleString() : "—"} ·{" "}
                {k.last_used_at ? `last used ${new Date(k.last_used_at + "Z").toLocaleString()}` : "never used"}
              </p>
            </div>
          ))}
          <p className="text-[11px] text-zinc-600">
            Connect OpenClaw (or any OpenAI-compatible client): set base URL to{" "}
            <code className="text-zinc-400">{origin}/v1</code> and the API key to a <code className="text-zinc-400">tam_gk_…</code>{" "}
            secret — use <b>Copy API key</b> on the key above.
          </p>
          {rotateErr && <p className="text-xs text-red-400">{rotateErr}</p>}
        </div>
      )}
    </Card>
  );
}
