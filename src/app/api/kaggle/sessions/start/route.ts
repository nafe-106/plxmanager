import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { startPlexusSession } from "@/lib/kaggle";

// POST /api/kaggle/sessions/start
// Push the bundled Plexus bootstrap (Ollama + proxy + Cloudflare + Supabase
// keep-alive) to an account and start watching it.
//
// body: { accountId, label?, slugName?, title?, brainModel?, visionModel?, extraModels? }
export async function POST(req: Request) {
  const g = await guard();
  if (g) return g;
  const body = await req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  if (!accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 });

  const res = await startPlexusSession(accountId, {
    label: body.label ? String(body.label).slice(0, 200) : undefined,
    slugName: body.slugName ? String(body.slugName) : undefined,
    title: body.title ? String(body.title) : undefined,
    brainModel: body.brainModel ? String(body.brainModel) : undefined,
    visionModel: body.visionModel ? String(body.visionModel) : undefined,
    extraModels:
      typeof body.extraModels === "string"
        ? String(body.extraModels)
        : Array.isArray(body.extraModels)
          ? body.extraModels.map((m: unknown) => String(m))
          : undefined,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json(res, { status: 201 });
}