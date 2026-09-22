import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { rows } from "@/lib/store";
import { createGeneralKey, generalKeyStats } from "@/lib/general";
import { timezone } from "@/lib/settings";

// ----- General (round-robin) keys · admin routes ----------------------------
// GET  /api/general-keys        list keys + aggregate usage
// POST /api/general-keys        create { name, note } -> { id, secret }
//                               (secret is shown once, only here)

export async function GET() {
  const g = await guard();
  if (g) return g;
  const zone = await timezone();
  const all = await rows<any>(
    "general_keys",
    {},
    { order: "id" }
  );
  const keys = [];
  for (const r of all) {
    keys.push({
      id: r.id,
      name: r.name,
      note: r.note,
      enabled: r.enabled,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      hasSecret: !!r.secret_enc,
      ...(await generalKeyStats(r.id, zone)),
    });
  }
  return NextResponse.json({ keys });
}

export async function POST(req: Request) {
  const g = await guard();
  if (g) return g;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; note?: unknown };
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const { id, secret } = await createGeneralKey(name, String(body.note ?? ""));
  return NextResponse.json(
    { key: { id, name, secret, baseUrl: "/v1" } },
    { status: 201 }
  );
}