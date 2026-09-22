import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { rows, insertRow } from "@/lib/store";
import { encrypt } from "@/lib/crypto";
import { getAccount, gpuUsedHoursThisWeek, gpuRemainingHours, weeklyGpuHistory } from "@/lib/kaggle";

export async function GET() {
  const g = await guard();
  if (g) return g;
  const all = await rows<any>("kaggle_accounts", {}, { order: "id" });
  const accounts = [];
  for (const a of all) {
    const { api_key_enc, ...rest } = a;
    const account = await getAccount(a.id);
    const hasApiQuota = a.quota_source === "api" && Number(a.quota_total_h) > 0;
    accounts.push({
      ...rest,
      masked_key: a.api_key_enc ? a.username.slice(0, 2) + "…" : "",
      used_hours: Math.round((await gpuUsedHoursThisWeek(a.id)) * 10) / 10,
      remaining_hours: account ? Math.round((await gpuRemainingHours(account)) * 10) / 10 : 0,
      quota_used_h: hasApiQuota ? Math.round((a.quota_used_h ?? 0) * 10) / 10 : null,
      quota_total_h: hasApiQuota ? Math.round((a.quota_total_h ?? 0) * 10) / 10 : null,
      quota_reserved_h: hasApiQuota ? Math.round((a.quota_reserved_h ?? 0) * 10) / 10 : null,
      quota_refresh_at: hasApiQuota ? (a.quota_refresh_at ?? null) : null,
      quota_source: a.quota_source ?? "local",
      history: await weeklyGpuHistory(a.id),
    });
  }
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
  const inserted = await insertRow<any>("kaggle_accounts", {
    label,
    username,
    api_key_enc: encrypt(apiKey),
    refresh_token_enc: refreshToken ? encrypt(refreshToken) : null,
    weekly_gpu_quota_h: quota,
    week_reset_day: resetDay,
  });
  return NextResponse.json({ id: Number(inserted.id) }, { status: 201 });
}