import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { byId } from "@/lib/store";
import { revealGeneralKeySecret } from "@/lib/general";

// GET /api/general-keys/[id]/secret — reveal the tam_gk_ secret (admin-guarded).
// Returns 404 when the key predates encrypted storage; use rotate instead.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const gkId = Number(id);
  if (!Number.isFinite(gkId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const keyRow = await byId<{ id: number; name: string }>("general_keys", gkId);
  if (!keyRow) return NextResponse.json({ error: "not found" }, { status: 404 });

  const secret = await revealGeneralKeySecret(gkId);
  if (!secret) {
    return NextResponse.json({ error: "Legacy key: secret was stored hash-only. Regenerate the secret to copy it." }, { status: 404 });
  }
  return NextResponse.json({ apiKey: secret });
}