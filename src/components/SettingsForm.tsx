"use client";

import { useEffect, useState } from "react";
import { Button, Card } from "./ui";

type SettingsResponse = {
  settings: Record<string, string | { value: string; saved: boolean; preview: string }>;
  passwordSource: string;
  env: { runtime: string; db: string; timezoneLabel: string };
};

const WEEK_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function SettingsForm() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [newPassword, setNewPassword] = useState("");
  const [resetPassword, setResetPassword] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j: SettingsResponse) => {
        setData(j);
        const v: Record<string, string> = {};
        const s: Record<string, boolean> = {};
        const c: Record<string, boolean> = {};
        for (const [k, val] of Object.entries(j.settings)) {
          if (typeof val === "string") {
            v[k] = val;
          } else {
            v[k] = "";
            s[k] = val.saved;
          }
        }
        c.alert_enabled = v.alert_enabled === "1";
        c.alert_on_key_dead = v.alert_on_key_dead === "1";
        c.plexus_auto_switch = v.plexus_auto_switch === "1";
        setValues(v);
        setSaved(s);
        setChecks(c);
      });
  }, []);

  function setVal(key: string, val: string) {
    setValues((p) => ({ ...p, [key]: val }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      timezone: values.timezone,
      check_interval_minutes: values.check_interval_minutes,
      kaggle_poll_minutes: values.kaggle_poll_minutes,
      usage_week_reset_day: values.usage_week_reset_day,
      alert_enabled: checks.alert_enabled ? "1" : "0",
      alert_on_key_dead: checks.alert_on_key_dead ? "1" : "0",
      plexus_auto_switch: checks.plexus_auto_switch ? "1" : "0",
      telegram_bot_token: values.telegram_bot_token,
      telegram_chat_id: values.telegram_chat_id,
      alert_webhook_url: values.alert_webhook_url,
      plexus_supabase_url: values.plexus_supabase_url,
      plexus_supabase_key: values.plexus_supabase_key,
      plexus_token: values.plexus_token,
      plexus_switch_threshold_h: values.plexus_switch_threshold_h,
      plexus_brain_model: values.plexus_brain_model,
      plexus_vision_model: values.plexus_vision_model,
    };
    if (newPassword.trim()) body.admin_password = newPassword.trim();
    if (resetPassword) body.admin_password_reset = true;

    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setToast("Failed to save settings");
    } else {
      setToast("Settings saved. Background jobs re-scheduled.");
      setNewPassword("");
      setResetPassword(false);
      // refresh saved-state for secret fields
      const j: SettingsResponse = await (await fetch("/api/settings")).json();
      const s: Record<string, boolean> = {};
      for (const [k, val] of Object.entries(j.settings)) {
        if (typeof val !== "string") s[k] = val.saved;
      }
      setSaved(s);
    }
    setTimeout(() => setToast(""), 3500);
  }

  if (!data) return <p className="text-sm text-zinc-500">Loading settings…</p>;

  return (
    <form onSubmit={save} className="space-y-4">
      {toast && (
        <div className="rounded-lg border border-emerald-700 bg-emerald-950/60 px-4 py-2.5 text-sm text-emerald-200">{toast}</div>
      )}

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">Scheduling & timezone</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Timezone (IANA)">
            <input className={inputCls} value={values.timezone ?? ""} onChange={(e) => setVal("timezone", e.target.value)} placeholder="Asia/Dhaka" />
          </Field>
          <Field label="Key health check (minutes)">
            <input type="number" min="1" className={inputCls} value={values.check_interval_minutes ?? ""} onChange={(e) => setVal("check_interval_minutes", e.target.value)} />
          </Field>
          <Field label="Kaggle poll (minutes)">
            <input type="number" min="1" className={inputCls} value={values.kaggle_poll_minutes ?? ""} onChange={(e) => setVal("kaggle_poll_minutes", e.target.value)} />
          </Field>
        </div>
        <Field label="Week reset day (used for keys' weekly hits & GPU week boundaries)">
          <select className={inputCls} value={values.usage_week_reset_day ?? "0"} onChange={(e) => setVal("usage_week_reset_day", e.target.value)}>
            {WEEK_NAMES.map((n, i) => (
              <option key={n} value={i}>{n}</option>
            ))}
          </select>
        </Field>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">Alerts</h3>
        <div className="flex flex-wrap gap-4 text-sm text-zinc-300">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!checks.alert_enabled} onChange={(e) => setChecks((p) => ({ ...p, alert_enabled: e.target.checked }))} />
            Enable alerts
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!checks.alert_on_key_dead} onChange={(e) => setChecks((p) => ({ ...p, alert_on_key_dead: e.target.checked }))} />
            Alert on API key death
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <SecretField label="Telegram bot token" placeholder={placeholder(saved.telegram_bot_token)} value={values.telegram_bot_token ?? ""} onChange={(v) => setVal("telegram_bot_token", v)} />
          <SecretField label="Telegram chat ID" placeholder={placeholder(saved.telegram_chat_id)} value={values.telegram_chat_id ?? ""} onChange={(v) => setVal("telegram_chat_id", v)} />
          <SecretField label="Webhook URL" placeholder={placeholder(saved.alert_webhook_url)} value={values.alert_webhook_url ?? ""} onChange={(v) => setVal("alert_webhook_url", v)} />
        </div>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">Plexus endpoint</h3>
        <p className="text-xs text-zinc-500">
          The Plexus bootstrap on Kaggle publishes its current Cloudflare tunnel URL to a Supabase table
          (<span className="font-mono">plexus_endpoint</span>, row id=1). Target API Manager reads it and checks{" "}
          <span className="font-mono">/api/tags</span> to show the GPU Ollama server as alive or dead.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <SecretField label="Supabase URL" placeholder={placeholder(saved.plexus_supabase_url)} value={values.plexus_supabase_url ?? ""} onChange={(v) => setVal("plexus_supabase_url", v)} />
          <SecretField label="Supabase anon/service key" placeholder={placeholder(saved.plexus_supabase_key)} value={values.plexus_supabase_key ?? ""} onChange={(v) => setVal("plexus_supabase_key", v)} />
        </div>
        <SecretField label="Endpoint bearer token (same token the auth proxy expects)" placeholder={placeholder(saved.plexus_token)} value={values.plexus_token ?? ""} onChange={(v) => setVal("plexus_token", v)} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Switch when ≤ (GPU hours left)">
            <input type="number" min="0" step="0.5" className={inputCls} value={values.plexus_switch_threshold_h ?? "1.5"} onChange={(e) => setVal("plexus_switch_threshold_h", e.target.value)} />
          </Field>
          <Field label="Brain model (default)">
            <input className={inputCls} value={values.plexus_brain_model ?? "qwen3:30b"} onChange={(e) => setVal("plexus_brain_model", e.target.value)} />
          </Field>
          <Field label="Vision model (default)">
            <input className={inputCls} value={values.plexus_vision_model ?? "qwen2.5vl:7b"} onChange={(e) => setVal("plexus_vision_model", e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={!!checks.plexus_auto_switch} onChange={(e) => setChecks((p) => ({ ...p, plexus_auto_switch: e.target.checked }))} />
          Auto-switch accounts when GPU limit is reached
        </label>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-zinc-200">Admin password</h3>
        <p className="text-xs text-zinc-500">
          Current password source: <span className="font-mono">{data.passwordSource}</span>{" "}
          (a password set here overrides the .env value).
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="New password (blank = keep)">
            <input type="password" className={inputCls} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm text-zinc-300">
            <input type="checkbox" checked={resetPassword} onChange={(e) => setResetPassword(e.target.checked)} />
            Reset to .env / default password
          </label>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-600">
          Runtime: {data.env.runtime} · DB: {data.env.db} · Browser TZ: {data.env.timezoneLabel}
        </p>
        <Button variant="primary" type="submit" className="px-5 py-2">Save settings</Button>
      </div>
    </form>
  );
}

function placeholder(saved: boolean) {
  return saved ? "saved ✓ leave blank to keep" : "not set";
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Field label={label}>
      <input type="password" autoComplete="new-password" className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </Field>
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