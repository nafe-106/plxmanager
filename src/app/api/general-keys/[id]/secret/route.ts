import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { revealGeneralKeySecret } from "@/lib/general";

// GET /api/general-keys/[id]/secret — reveal the tam_gk_ secret (admin-guarded).
// Returns 404 when the key predates encrypted storage; use rotate instead.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const gkId = Number(id);
  if (!Number.isFinite(gkId)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const row = db.prepare("SELECT id, name FROM general_keys WHERE id = ?").get(gkId) as
    | { id: number; name: string }
    | undefined;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const secret = revealGeneralKeySecret(gkId);
  if (!secret) {
    return NextResponse.json({ error: "Legacy key: secret was stored hash-only. Regenerate the secret to copy it." }, { status: 404 });
  }
  return NextResponse.json({ apiKey: secret });
}
