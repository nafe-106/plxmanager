import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { restartSession } from "@/lib/kaggle";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const res = await restartSession(Number(id));
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}