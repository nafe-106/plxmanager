import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { byId, updateRow, deleteRows, nowSql } from "@/lib/store";
import { encrypt } from "@/lib/crypto";
import { saveKeyModels } from "@/lib/keys";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const keyId = Number(id);
  const body = await req.json().catch(() => ({}));

  const key = await byId<any>("api_keys", keyId);
  if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};

  if (body.provider !== undefined) {
    patch.provider = String(body.provider);
  }
  if (body.accountName !== undefined) {
    patch.account_name = String(body.accountName).slice(0, 200);
  }
  if (body.accountEmail !== undefined) {
    patch.account_email = String(body.accountEmail).slice(0, 300);
  }
  if (body.usageLimit !== undefined) {
    patch.usage_limit = Math.max(0, Number(body.usageLimit) || 0);
  }
  if (body.usagePeriod !== undefined) {
    patch.usage_period = ["daily", "monthly", "total"].includes(body.usagePeriod) ? body.usagePeriod : "monthly";
  }
  if (body.usageHour !== undefined) {
    patch.usage_hour = Math.max(0, Math.min(23, Math.round(Number(body.usageHour) || 0)));
  }
  if (body.baseUrl !== undefined) {
    patch.base_url = String(body.baseUrl).slice(0, 500);
  }
  if (body.disabled !== undefined) {
    patch.disabled = body.disabled ? 1 : 0;
  }
  if (body.apiKey !== undefined && String(body.apiKey)) {
    patch.api_key_enc = encrypt(String(body.apiKey));
    patch.status = "unknown";
    patch.last_error = "";
  }

  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  patch.updated_at = nowSql();
  await updateRow("api_keys", keyId, patch);
  if (Array.isArray(body.models)) await saveKeyModels(keyId, body.models);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const keyId = Number(id);
  await deleteRows("key_usage_hourly", { key_id: keyId });
  await deleteRows("key_checks", { key_id: keyId });
  await deleteRows("key_models", { key_id: keyId });
  await deleteRows("api_keys", { id: keyId });
  return NextResponse.json({ ok: true });
}