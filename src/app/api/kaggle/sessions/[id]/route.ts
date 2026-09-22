import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db, nowSql } from "@/lib/db";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const sessionId = Number(id);
  const body = await req.json().catch(() => ({}));
  const session = db.prepare("SELECT * FROM kaggle_sessions WHERE id = ?").get(sessionId) as any;
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const fields: string[] = [];
  const values: any[] = [];
  if (body.label !== undefined) { fields.push("label = ?"); values.push(String(body.label).slice(0, 200)); }
  if (body.slug !== undefined && String(body.slug).trim()) {
    const slug = String(body.slug).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9._-]+$/.test(slug)) {
      return NextResponse.json({ error: "slug must be owner/notebook-name" }, { status: 400 });
    }
    fields.push("slug = ?"); values.push(slug);
  }
  if (body.accountId !== undefined) {
    const account = db.prepare("SELECT id FROM kaggle_accounts WHERE id = ?").get(Number(body.accountId));
    if (!account) return NextResponse.json({ error: "account not found" }, { status: 400 });
    fields.push("account_id = ?"); values.push(Number(body.accountId));
  }
  if (body.autoSwitch !== undefined) { fields.push("auto_switch = ?"); values.push(body.autoSwitch ? 1 : 0); }
  if (body.paused !== undefined) { fields.push("paused = ?"); values.push(body.paused ? 1 : 0); }
  if (body.type !== undefined) {
    fields.push("type = ?");
    values.push(body.type === "plexus" ? "plexus" : "notebook");
    if (body.type === "plexus") { fields.push("plexus_status = 'unknown'"); }
  }
  if (!fields.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  fields.push("updated_at = ?");
  values.push(nowSql(), sessionId);
  db.prepare(`UPDATE kaggle_sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const sessionId = Number(id);
  db.prepare("DELETE FROM kaggle_session_events WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM kaggle_sessions WHERE id = ?").run(sessionId);
  return NextResponse.json({ ok: true });
}