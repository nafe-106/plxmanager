import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db, nowSql } from "@/lib/db";
import { encrypt } from "@/lib/crypto";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const accountId = Number(id);
  const body = await req.json().catch(() => ({}));
  const account = db.prepare("SELECT * FROM kaggle_accounts WHERE id = ?").get(accountId) as any;
  if (!account) return NextResponse.json({ error: "not found" }, { status: 404 });

  const fields: string[] = [];
  const values: any[] = [];
  if (body.label !== undefined) { fields.push("label = ?"); values.push(String(body.label).slice(0, 200)); }
  if (body.username !== undefined) { fields.push("username = ?"); values.push(String(body.username).trim().slice(0, 200)); }
  if (body.weeklyGpuQuotaH !== undefined) { fields.push("weekly_gpu_quota_h = ?"); values.push(Math.max(0, Number(body.weeklyGpuQuotaH) || 30)); }
  if (body.weekResetDay !== undefined) { fields.push("week_reset_day = ?"); values.push(Math.max(0, Math.min(6, Math.round(Number(body.weekResetDay) || 0)))); }
  if (body.disabled !== undefined) { fields.push("disabled = ?"); values.push(body.disabled ? 1 : 0); }
  if (body.apiKey !== undefined && String(body.apiKey)) { fields.push("api_key_enc = ?"); values.push(encrypt(String(body.apiKey))); }
  if (body.refreshToken !== undefined) { fields.push("refresh_token_enc = ?"); values.push(body.refreshToken ? encrypt(String(body.refreshToken)) : null); }
  if (!fields.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  fields.push("updated_at = ?");
  values.push(nowSql(), accountId);
  db.prepare(`UPDATE kaggle_accounts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const accountId = Number(id);
  db.prepare("UPDATE kaggle_sessions SET paused = 1 WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM gpu_usage_weekly WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM kaggle_accounts WHERE id = ?").run(accountId);
  return NextResponse.json({ ok: true });
}