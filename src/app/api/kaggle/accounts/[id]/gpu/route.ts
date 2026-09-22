import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db, nowSql } from "@/lib/db";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const accountId = Number(id);
  const body = await req.json().catch(() => ({}));

  if (body.clearOverride) {
    db.prepare("UPDATE kaggle_accounts SET remaining_override_h = NULL, override_set_at = NULL WHERE id = ?").run(accountId);
    return NextResponse.json({ ok: true });
  }

  const hours = Math.max(0, Number(body.hours) || 0);
  const account = db.prepare("SELECT * FROM kaggle_accounts WHERE id = ?").get(accountId) as any;
  if (!account) return NextResponse.json({ error: "not found" }, { status: 404 });
  db.prepare("UPDATE kaggle_accounts SET remaining_override_h = ?, override_set_at = ?, updated_at = ? WHERE id = ?")
    .run(hours, nowSql(), nowSql(), accountId);
  return NextResponse.json({ ok: true });
}