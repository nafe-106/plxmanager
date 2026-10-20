import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { createGeneralKey, listGeneralKeysWithStats } from "@/lib/general";

// ----- General (round-robin) keys · admin routes ----------------------------
// GET  /api/general-keys        list keys + aggregate usage
// POST /api/general-keys        create { name, note } -> { id, secret }
//                               (secret is shown once, only here)

export async function GET() {
  const g = await guard();
  if (g) return g;
  const keys = await listGeneralKeysWithStats();
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