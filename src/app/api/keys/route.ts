import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { timezone } from "@/lib/settings";
import { listKeysWithUsage, createKeyRows } from "@/lib/keys";

export async function GET() {
  const g = await guard();
  if (g) return g;
  const tz = await timezone();
  // One pass over keys + usage + models (3 queries) instead of re-fetching
  // every key's usage slice once per key and per model.
  const keys = await listKeysWithUsage(tz);
  return NextResponse.json({ keys });
}

export async function POST(req: Request) {
  const g = await guard();
  if (g) return g;
  const body = await req.json().catch(() => ({}));
  try {
    const { ids } = await createKeyRows(body);
    return NextResponse.json({ id: ids[0], ids }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
