import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { getAllSettings, setSetting, updateSettings, SETTING_DEFAULTS } from "@/lib/settings";
import { hashPassword } from "@/lib/crypto";
import { row, deleteRows } from "@/lib/store";
import { restartSchedulerJobs } from "@/lib/scheduler";

const SECRET_KEYS = [
  "telegram_bot_token",
  "telegram_chat_id",
  "alert_webhook_url",
  "plexus_supabase_url",
  "plexus_supabase_key",
  "plexus_token",
];

function mask(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "•".repeat(v.length);
  return "••••••" + v.slice(-4);
}

export async function GET() {
  const g = await guard();
  if (g) return g;
  const all = await getAllSettings();
  const out: Record<string, { value: string; saved: boolean; preview: string } | string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (SECRET_KEYS.includes(k)) {
      out[k] = { value: "", saved: !!v, preview: mask(v) };
    } else {
      out[k] = v;
    }
  }
  const storedPw = await row("settings", { key: "admin_password_hash" });
  return NextResponse.json({
    settings: out,
    passwordSource: storedPw ? "db" : process.env.ADMIN_PASSWORD ? "env" : "default",
    env: {
      runtime: process.env.NODE_ENV,
      db: process.env.DB_PATH || "data/tam.sqlite",
      timezoneLabel: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
}

export async function PUT(req: Request) {
  const g = await guard();
  if (g) return g;
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, string> = {};

  for (const key of Object.keys(SETTING_DEFAULTS)) {
    const v = body[key];
    if (v === undefined) continue;
    if (SECRET_KEYS.includes(key)) {
      if (typeof v === "string" && v.trim()) patch[key] = v.trim().slice(0, 500);
    } else {
      patch[key] = typeof v === "string" ? v.slice(0, 500) : String(v);
    }
  }
  await updateSettings(patch);

  if (body.admin_password && typeof body.admin_password === "string" && body.admin_password.trim()) {
    await setSetting("admin_password_hash", hashPassword(body.admin_password.trim()));
  }
  if (body.admin_password_reset) {
    await deleteRows("settings", { key: "admin_password_hash" });
  }

  void restartSchedulerJobs().catch(() => {});
  return NextResponse.json({ ok: true });
}