import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { verifyPassword } from "./crypto";
import { getSetting } from "./settings";

const SESSION_COOKIE = "tam_session";
const SESSION_LIFETIME_DAYS = 30;

// Sessions are stateless (HMAC-signed cookies) so they survive across
// serverless instances, each of which has its own /tmp SQLite DB.
// The secret must come from a stable source — never the per-instance DB.
function sessionSecret(): string {
  const env =
    process.env.ENCRYPTION_KEY?.trim() || process.env.ADMIN_PASSWORD?.trim();
  if (env) return env;
  return "tam-dev-session-secret";
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

export function createSession(): string {
  const payload = `${Date.now() + SESSION_LIFETIME_DAYS * 86400e3}.${crypto
    .randomBytes(24)
    .toString("hex")}`;
  return `${payload}.${sign(payload)}`;
}

export async function hasSession(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [exp, random, sig] = parts;
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]+$/.test(random)) return false;
  const expected = sign(`${exp}.${random}`);
  if (sig.length !== expected.length) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  } catch {
    return false;
  }
  return Number(exp) > Date.now();
}

export async function guard(): Promise<NextResponse | null> {
  if (await hasSession()) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export function destroySession(token: string): void {
  // Stateless sessions need no server-side deletion — the cookie is cleared
  // by the logout route.
  void token;
}

export async function expectedPasswordHash(): Promise<string | null> {
  const stored = await getSetting("admin_password_hash");
  if (stored) return stored;
  const env = process.env.ADMIN_PASSWORD;
  if (!env) return null;
  return `env:` + env;
}

export async function checkPassword(candidate: string): Promise<boolean> {
  // Env var is the source of truth when present (stable across lambda
  // instances); a stored hash from the Settings page can only ever refer to
  // the old env value, so check env first.
  const env = process.env.ADMIN_PASSWORD;
  if (env) {
    if (candidate === env) return true;
    try {
      const a = crypto.createHash("sha256").update(candidate).digest();
      const b = crypto.createHash("sha256").update(env).digest();
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {
      /* ignore */
    }
  }
  const stored = await getSetting("admin_password_hash");
  if (stored) {
    try {
      return verifyPassword(candidate, stored);
    } catch {
      return false;
    }
  }
  return candidate === "admin";
}