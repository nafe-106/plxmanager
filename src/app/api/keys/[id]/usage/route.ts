import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { logKeyUsage } from "@/lib/keys";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const keyId = Number(id);
  const body = await req.json().catch(() => ({}));
  const tokens = Math.max(0, Number(body.tokens) || 0);
  const success = body.success !== false;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 200) : undefined;
  logKeyUsage(keyId, tokens, success, model);
  return NextResponse.json({ ok: true });
}