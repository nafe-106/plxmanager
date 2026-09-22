import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { resetKeyUsage } from "@/lib/keys";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const deleted = resetKeyUsage(Number(id));
  return NextResponse.json({ ok: true, cleared: deleted });
}