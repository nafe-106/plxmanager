import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { rotateGeneralKeySecret } from "@/lib/general";

// PATCH /api/general-keys/[id]  { enabled?, name?, note?, rotateSecret? }
// DELETE /api/general-keys/[id] remove key + its usage logs

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const gkId = Number(id);
  const row = db.prepare("SELECT id FROM general_keys WHERE id = ?").get(gkId);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    enabled?: unknown;
    name?: unknown;
    note?: unknown;
    rotateSecret?: unknown;
  };
  if (body.rotateSecret) {
    const secret = rotateGeneralKeySecret(gkId);
    if (!secret) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, secret });
  }
  const fields: string[] = [];
  const values: unknown[] = [];
  if (body.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(body.enabled ? 1 : 0);
  }
  if (body.name !== undefined && String(body.name).trim()) {
    fields.push("name = ?");
    values.push(String(body.name).trim().slice(0, 200));
  }
  if (body.note !== undefined) {
    fields.push("note = ?");
    values.push(String(body.note).slice(0, 500));
  }
  if (!fields.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  values.push(gkId);
  db.prepare(`UPDATE general_keys SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const gkId = Number(id);
  db.prepare("DELETE FROM general_key_logs WHERE gk_id = ?").run(gkId);
  db.prepare("DELETE FROM general_keys WHERE id = ?").run(gkId);
  return NextResponse.json({ ok: true });
}
