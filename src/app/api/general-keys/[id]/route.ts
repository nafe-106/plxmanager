import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { byId, updateRow, deleteRows } from "@/lib/store";
import { rotateGeneralKeySecret } from "@/lib/general";

// PATCH /api/general-keys/[id]  { enabled?, name?, note?, rotateSecret? }
// DELETE /api/general-keys/[id] remove key + its usage logs

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const gkId = Number(id);
  const keyRow = await byId<any>("general_keys", gkId);
  if (!keyRow) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    enabled?: unknown;
    name?: unknown;
    note?: unknown;
    rotateSecret?: unknown;
  };
  if (body.rotateSecret) {
    const secret = await rotateGeneralKeySecret(gkId);
    if (!secret) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, secret });
  }
  const patch: Record<string, unknown> = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled ? 1 : 0;
  if (body.name !== undefined && String(body.name).trim()) patch.name = String(body.name).trim().slice(0, 200);
  if (body.note !== undefined) patch.note = String(body.note).slice(0, 500);
  if (!Object.keys(patch).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  await updateRow("general_keys", gkId, patch);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const gkId = Number(id);
  await deleteRows("general_key_logs", { gk_id: gkId });
  await deleteRows("general_keys", { id: gkId });
  return NextResponse.json({ ok: true });
}