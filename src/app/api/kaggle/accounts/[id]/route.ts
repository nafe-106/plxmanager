import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { byId, updateRow, updateRows, deleteRows, nowSql } from "@/lib/store";
import { encrypt } from "@/lib/crypto";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const accountId = Number(id);
  const body = await req.json().catch(() => ({}));
  const account = await byId<any>("kaggle_accounts", accountId);
  if (!account) return NextResponse.json({ error: "not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (body.label !== undefined) patch.label = String(body.label).slice(0, 200);
  if (body.username !== undefined) patch.username = String(body.username).trim().slice(0, 200);
  if (body.weeklyGpuQuotaH !== undefined) patch.weekly_gpu_quota_h = Math.max(0, Number(body.weeklyGpuQuotaH) || 30);
  if (body.weekResetDay !== undefined) patch.week_reset_day = Math.max(0, Math.min(6, Math.round(Number(body.weekResetDay) || 0)));
  if (body.disabled !== undefined) patch.disabled = body.disabled ? 1 : 0;
  if (body.apiKey !== undefined && String(body.apiKey)) patch.api_key_enc = encrypt(String(body.apiKey));
  if (body.refreshToken !== undefined) patch.refresh_token_enc = body.refreshToken ? encrypt(String(body.refreshToken)) : null;
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  patch.updated_at = nowSql();
  await updateRow("kaggle_accounts", accountId, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const accountId = Number(id);
  await updateRows("kaggle_sessions", { account_id: accountId }, { paused: 1 });
  await deleteRows("gpu_usage_weekly", { account_id: accountId });
  await deleteRows("kaggle_accounts", { id: accountId });
  return NextResponse.json({ ok: true });
}