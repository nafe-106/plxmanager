import { db } from "./db";

export type SettingsMap = Record<string, string>;

export const SETTING_DEFAULTS: Record<string, string> = {
  timezone: "Asia/Dhaka",
  check_interval_minutes: "10",
  kaggle_poll_minutes: "3",
  usage_week_reset_day: "0", // 0=Sunday .. 6=Saturday
  alert_enabled: "1",
  alert_on_key_dead: "1",
  telegram_bot_token: "",
  telegram_chat_id: "",
  alert_webhook_url: "",
  plexus_supabase_url: "",
  plexus_supabase_key: "",
  plexus_token: "PLEXUS_KAGGLE_2026",
  plexus_auto_switch: "1",
  plexus_switch_threshold_h: "1.5",
  plexus_brain_model: "qwen3:30b",
  plexus_vision_model: "qwen2.5vl:7b",
};

// Allow the Plexus/Supabase settings to be supplied via env vars instead of
// the DB. DB values always win; env is the fallback.
const ENV_FALLBACK: Partial<Record<string, () => string | undefined>> = {
  plexus_supabase_url: () =>
    process.env.PLEXUS_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  plexus_supabase_key: () =>
    process.env.PLEXUS_SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  plexus_token: () => process.env.PLEXUS_TOKEN || "PLEXUS_KAGGLE_2026",
};

export function getSetting(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (row) return row.value;
  const fallback = ENV_FALLBACK[key];
  if (fallback) {
    const v = fallback();
    return v && v.length ? v : null;
  }
  return null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getAllSettings(): SettingsMap {
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  const map: SettingsMap = { ...SETTING_DEFAULTS };
  for (const r of rows) map[r.key] = r.value;
  return map;
}

export function timezone(): string {
  return getSetting("timezone") || SETTING_DEFAULTS.timezone;
}

export function updateSettings(patch: Record<string, string>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in SETTING_DEFAULTS)) continue;
    setSetting(k, v);
  }
}