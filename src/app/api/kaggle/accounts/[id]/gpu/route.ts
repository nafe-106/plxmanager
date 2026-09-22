import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { byId, updateRow, nowSql } from "@/lib/store";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const accountId = Number(id);
  const body = await req.json().catch(() => ({}));

  if (body.clearOverride) {
    await updateRow("kaggle_accounts", accountId, { remaining_override_h: null, override_set_at: null });
    return NextResponse.json({ ok: true });
  }

  const hours = Math.max(0, Number(body.hours) || 0);
  const account = await byId<any>("kaggle_accounts", accountId);
  if (!account) return NextResponse.json({ error: "not found" }, { status: 404 });
  await updateRow("kaggle_accounts", accountId, {
    remaining_override_h: hours,
    override_set_at: nowSql(),
    updated_at: nowSql(),
  });
  return NextResponse.json({ ok: true });
}