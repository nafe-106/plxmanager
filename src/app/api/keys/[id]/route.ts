import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db, nowSql } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { saveKeyModels } from "@/lib/keys";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const keyId = Number(id);
  const body = await req.json().catch(() => ({}));

  const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyId) as any;
  if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });

  const fields: string[] = [];
  const values: any[] = [];

  if (body.provider !== undefined) {
    fields.push("provider = ?");
    values.push(String(body.provider));
  }
  if (body.accountName !== undefined) {
    fields.push("account_name = ?");
    values.push(String(body.accountName).slice(0, 200));
  }
  if (body.accountEmail !== undefined) {
    fields.push("account_email = ?");
    values.push(String(body.accountEmail).slice(0, 300));
  }
  if (body.usageLimit !== undefined) {
    fields.push("usage_limit = ?");
    values.push(Math.max(0, Number(body.usageLimit) || 0));
  }
  if (body.usagePeriod !== undefined) {
    fields.push("usage_period = ?");
    values.push(["daily", "monthly", "total"].includes(body.usagePeriod) ? body.usagePeriod : "monthly");
  }
  if (body.usageHour !== undefined) {
    fields.push("usage_hour = ?");
    values.push(Math.max(0, Math.min(23, Math.round(Number(body.usageHour) || 0))));
  }
  if (body.baseUrl !== undefined) {
    fields.push("base_url = ?");
    values.push(String(body.baseUrl).slice(0, 500));
  }
  if (body.disabled !== undefined) {
    fields.push("disabled = ?");
    values.push(body.disabled ? 1 : 0);
  }
  if (body.apiKey !== undefined && String(body.apiKey)) {
    fields.push("api_key_enc = ?");
    values.push(encrypt(String(body.apiKey)));
    fields.push("status = 'unknown'");
    fields.push("last_error = ''");
  }

  if (!fields.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  fields.push("updated_at = ?");
  values.push(nowSql());
  values.push(keyId);
  db.prepare(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  if (Array.isArray(body.models)) saveKeyModels(keyId, body.models);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const keyId = Number(id);
  db.prepare("DELETE FROM key_usage_hourly WHERE key_id = ?").run(keyId);
  db.prepare("DELETE FROM key_checks WHERE key_id = ?").run(keyId);
  db.prepare("DELETE FROM key_models WHERE key_id = ?").run(keyId);
  db.prepare("DELETE FROM api_keys WHERE id = ?").run(keyId);
  return NextResponse.json({ ok: true });
}