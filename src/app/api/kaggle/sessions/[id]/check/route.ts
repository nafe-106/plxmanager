import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { watchSession, getSession } from "@/lib/kaggle";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const session = getSession(Number(id));
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    await watchSession(session);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "check failed" }, { status: 500 });
  }
}