import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { byId, updateRow, deleteRows, nowSql } from "@/lib/store";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const sessionId = Number(id);
  const body = await req.json().catch(() => ({}));
  const session = await byId<any>("kaggle_sessions", sessionId);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (body.label !== undefined) patch.label = String(body.label).slice(0, 200);
  if (body.slug !== undefined && String(body.slug).trim()) {
    const slug = String(body.slug).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9._-]+$/.test(slug)) {
      return NextResponse.json({ error: "slug must be owner/notebook-name" }, { status: 400 });
    }
    patch.slug = slug;
  }
  if (body.accountId !== undefined) {
    const account = await byId<any>("kaggle_accounts", Number(body.accountId));
    if (!account) return NextResponse.json({ error: "account not found" }, { status: 400 });
    patch.account_id = Number(body.accountId);
  }
  if (body.autoSwitch !== undefined) patch.auto_switch = body.autoSwitch ? 1 : 0;
  if (body.paused !== undefined) patch.paused = body.paused ? 1 : 0;
  if (body.type !== undefined) {
    patch.type = body.type === "plexus" ? "plexus" : "notebook";
    if (body.type === "plexus") patch.plexus_status = "unknown";
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  patch.updated_at = nowSql();
  await updateRow("kaggle_sessions", sessionId, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const sessionId = Number(id);
  await deleteRows("kaggle_session_events", { session_id: sessionId });
  await deleteRows("kaggle_sessions", { id: sessionId });
  return NextResponse.json({ ok: true });
}