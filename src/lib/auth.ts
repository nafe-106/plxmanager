import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { db } from "./db";
import { verifyPassword } from "./crypto";
import { getSetting } from "./settings";

const SESSION_COOKIE = "tam_session";
const SESSION_LIFETIME_DAYS = 30;

export async function hasSession(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const row = db
    .prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > datetime('now')")
    .get(token);
  return !!row;
}

export async function guard(): Promise<NextResponse | null> {
  if (await hasSession()) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export function createSession(): string {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO sessions(token, expires_at) VALUES(?, datetime('now', '+' || ? || ' days'))"
  ).run(token, SESSION_LIFETIME_DAYS);
  return token;
}

export function destroySession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function expectedPasswordHash(): string | null {
  const stored = getSetting("admin_password_hash");
  if (stored) return stored;
  const env = process.env.ADMIN_PASSWORD;
  if (!env) return null;
  return `env:` + env;
}

export function checkPassword(candidate: string): boolean {
  const stored = expectedPasswordHash();
  if (!stored) return candidate === "admin";
  if (stored.startsWith("env:")) {
    const a = crypto.createHash("sha256").update(candidate).digest();
    const b = crypto.createHash("sha256").update(stored.slice(4)).digest();
    return crypto.timingSafeEqual(a, b);
  }
  return verifyPassword(candidate, stored);
}