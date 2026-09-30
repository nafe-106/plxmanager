import { row, rows, upsertRows } from "./store";

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
  plexus_extra_models: "",
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

export async function getSetting(key: string): Promise<string | null> {
  const r = await row<{ value: string }>("settings", { key });
  if (r) return r.value;
  const fallback = ENV_FALLBACK[key];
  if (fallback) {
    const v = fallback();
    return v && v.length ? v : null;
  }
  // Generic env fallback: TIMEZONE, CHECK_INTERVAL_MINUTES, KAGGLE_POLL_MINUTES, …
  const envV = process.env[key.toUpperCase()];
  if (envV && envV.length) return envV;
  return null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await upsertRows("settings", [{ key, value }], "key");
}

export async function getAllSettings(): Promise<SettingsMap> {
  const rowsArr = await rows<{ key: string; value: string }>("settings");
  const map: SettingsMap = { ...SETTING_DEFAULTS };
  for (const r of rowsArr) map[r.key] = r.value;
  return map;
}

export async function timezone(): Promise<string> {
  return (await getSetting("timezone")) || SETTING_DEFAULTS.timezone;
}

export async function updateSettings(patch: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in SETTING_DEFAULTS)) continue;
    await setSetting(k, v);
  }
}