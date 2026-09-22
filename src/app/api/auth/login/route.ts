import { NextResponse } from "next/server";
import { createSession, checkPassword, expectedPasswordHash } from "@/lib/auth";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const password = String(body?.password ?? "");
  if (!(await checkPassword(password))) {
    const pwh = await expectedPasswordHash();
    const hint = process.env.ADMIN_PASSWORD
      ? `env(len=${process.env.ADMIN_PASSWORD.length})`
      : pwh
        ? `dbhash(${pwh.length} chars)`
        : "nodefault";
    console.error(`[login] denied; source=${hint}`);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }
  const token = createSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set("tam_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}