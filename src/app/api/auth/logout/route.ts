import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { destroySession } from "@/lib/auth";

export async function POST() {
  const store = await cookies();
  const token = store.get("tam_session")?.value;
  if (token) destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("tam_session", "", { maxAge: 0, path: "/" });
  return res;
}