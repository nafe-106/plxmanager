import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { decrypt, maskKey } from "@/lib/crypto";
import { timezone } from "@/lib/settings";
import { withUsage, listKeys, createKeyRow } from "@/lib/keys";

export async function GET() {
  const g = await guard();
  if (g) return g;
  const tz = await timezone();
  const raw = await listKeys();
  const rows = [];
  for (const k of raw) {
    const enriched = await withUsage(k, tz);
    (enriched as any).provider_mask = maskKey(decrypt(k.api_key_enc));
    delete enriched.api_key_enc;
    rows.push(enriched);
  }
  return NextResponse.json({ keys: rows });
}

export async function POST(req: Request) {
  const g = await guard();
  if (g) return g;
  const body = await req.json().catch(() => ({}));
  try {
    const { id } = await createKeyRow(body);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}