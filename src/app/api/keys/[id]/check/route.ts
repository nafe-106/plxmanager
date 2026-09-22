import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { timezone } from "@/lib/settings";
import { withUsage, checkKey, keyUsageHours, keyUsageSummary } from "@/lib/keys";
import { decrypt } from "@/lib/crypto";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  try {
    const key = await checkKey(Number(id));
    const row = withUsage(key, timezone());
    (row as any).provider_mask = (key as any).api_key_enc ? "…" : "";
    delete row.api_key_enc;
    return NextResponse.json({ key: row });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "check failed" }, { status: 500 });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const keyId = Number(id);
  const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyId) as any;
  if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });
  const row = withUsage(key, timezone());
  (row as any).provider_mask = key.api_key_enc ? decrypt(key.api_key_enc).slice(0, 8) + "…" : "";
  delete row.api_key_enc;

  const checks = db
    .prepare("SELECT * FROM key_checks WHERE key_id = ? ORDER BY id DESC LIMIT 30")
    .all(keyId) as any[];

  return NextResponse.json({
    key: row,
    hours: keyUsageHours(keyId),
    summary: keyUsageSummary(keyId),
    checks,
  });
}