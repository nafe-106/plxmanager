import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { byId, rows } from "@/lib/store";
import { timezone } from "@/lib/settings";
import { withUsage, checkKey, keyUsageHours, keyUsageSummary } from "@/lib/keys";
import { decrypt } from "@/lib/crypto";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  try {
    const key = await checkKey(Number(id));
    const rowData = await withUsage(key, await timezone());
    (rowData as any).provider_mask = (key as any).api_key_enc ? "…" : "";
    delete rowData.api_key_enc;
    return NextResponse.json({ key: rowData });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "check failed" }, { status: 500 });
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const keyId = Number(id);
  const key = await byId<any>("api_keys", keyId);
  if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });
  const rowData = await withUsage(key, await timezone());
  (rowData as any).provider_mask = key.api_key_enc ? decrypt(key.api_key_enc).slice(0, 8) + "…" : "";
  delete rowData.api_key_enc;

  const checks = await rows<any>(
    "key_checks",
    { key_id: keyId },
    { order: "id", asc: false, limit: 30 }
  );

  return NextResponse.json({
    key: rowData,
    hours: await keyUsageHours(keyId),
    summary: await keyUsageSummary(keyId),
    checks,
  });
}