import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { gpuUsedHoursThisWeek, gpuRemainingHours, weeklyGpuHistory, getAccount } from "@/lib/kaggle";

export async function GET() {
  const g = await guard();
  if (g) return g;
  const rows = db.prepare("SELECT * FROM kaggle_accounts ORDER BY id").all() as any[];
  const accounts = rows.map((a) => {
    const { api_key_enc, ...rest } = a;
    const account = getAccount(a.id)!;
    const hasApiQuota = a.quota_source === "api" && Number(a.quota_total_h) > 0;
    return {
      ...rest,
      masked_key: a.api_key_enc ? a.username.slice(0, 2) + "…" : "",
      used_hours: Math.round(gpuUsedHoursThisWeek(a.id) * 10) / 10,
      remaining_hours: Math.round(gpuRemainingHours(account) * 10) / 10,
      quota_used_h: hasApiQuota ? Math.round((a.quota_used_h ?? 0) * 10) / 10 : null,
      quota_total_h: hasApiQuota ? Math.round((a.quota_total_h ?? 0) * 10) / 10 : null,
      quota_reserved_h: hasApiQuota ? Math.round((a.quota_reserved_h ?? 0) * 10) / 10 : null,
      quota_refresh_at: hasApiQuota ? (a.quota_refresh_at ?? null) : null,
      quota_source: a.quota_source ?? "local",
      history: weeklyGpuHistory(a.id),
    };
  });
  return NextResponse.json({ accounts });
}

export async function POST(req: Request) {
  const g = await guard();
  if (g) return g;
  const body = await req.json().catch(() => ({}));
  const label = String(body.label || "").slice(0, 200);
  const username = String(body.username || "").trim().slice(0, 200);
  const apiKey = String(body.apiKey || "");
  if (!label || !username || !apiKey) {
    return NextResponse.json({ error: "label, username and apiKey are required" }, { status: 400 });
  }
  const quota = Math.max(0, Number(body.weeklyGpuQuotaH) || 30);
  const resetDay = Math.max(0, Math.min(6, Math.round(Number(body.weekResetDay) || 0)));
  const refreshToken = String(body.refreshToken || "").trim();
  const info = db
    .prepare(
      `INSERT INTO kaggle_accounts(label, username, api_key_enc, refresh_token_enc, weekly_gpu_quota_h, week_reset_day)
       VALUES(?, ?, ?, ?, ?, ?)`
    )
    .run(label, username, encrypt(apiKey), refreshToken ? encrypt(refreshToken) : null, quota, resetDay);
  return NextResponse.json({ id: Number(info.lastInsertRowid) }, { status: 201 });
}