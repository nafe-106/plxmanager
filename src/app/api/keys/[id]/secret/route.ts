import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { byId } from "@/lib/store";
import { decrypt } from "@/lib/crypto";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const keyId = Number(id);
  const key = await byId<any>("api_keys", keyId);
  if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ apiKey: decrypt(key.api_key_enc) });
}