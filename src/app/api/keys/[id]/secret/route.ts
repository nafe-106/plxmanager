import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const keyId = Number(id);
  const key = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyId) as any;
  if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ apiKey: decrypt(key.api_key_enc) });
}