import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { createGeneralKey, generalKeyStats } from "@/lib/general";
import { timezone } from "@/lib/settings";

// ----- General (round-robin) keys · admin routes ----------------------------
// GET  /api/general-keys        list keys + aggregate usage
// POST /api/general-keys        create { name, note } -> { id, secret }
//                               (secret is shown once, only here)

export async function GET() {
  const g = await guard();
  if (g) return g;
  const zone = timezone();
  const rows = db
    .prepare("SELECT id, name, note, enabled, created_at, last_used_at, secret_enc FROM general_keys ORDER BY id")
    .all() as {
    id: number;
    name: string;
    note: string;
    enabled: number;
    created_at: string;
    last_used_at: string | null;
    secret_enc: string | null;
  }[];
  const keys = rows.map((r) => ({
    id: r.id,
    name: r.name,
    note: r.note,
    enabled: r.enabled,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    hasSecret: !!r.secret_enc,
    ...generalKeyStats(r.id, zone),
  }));
  return NextResponse.json({ keys });
}

export async function POST(req: Request) {
  const g = await guard();
  if (g) return g;
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; note?: unknown };
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const { id, secret } = createGeneralKey(name, String(body.note ?? ""));
  return NextResponse.json(
    { key: { id, name, secret, baseUrl: "/v1" } },
    { status: 201 }
  );
}
