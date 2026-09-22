import crypto from "node:crypto";
import { db } from "./db";

// ----- Encryption key resolution -----------------------------------------
// Precedence: ENCRYPTION_KEY env -> settings.encryption_key -> generate & persist.
export function encKeyHex(): string {
  const env = process.env.ENCRYPTION_KEY?.trim();
  if (env) return env;

  const stored = getSetting("encryption_key");
  if (stored) return stored;

  const generated = crypto.randomBytes(32).toString("hex");
  setSetting("encryption_key", generated);
  return generated;
}

export function encKeyBuffer(): Buffer {
  return crypto.createHash("sha256").update(encKeyHex()).digest();
}

function getSetting(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

// ----- Encrypt / decrypt --------------------------------------------------
export function encrypt(plain: string): string {
  const key = encKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(payload: string): string {
  if (!payload) return "";
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  const [, iv, tag, data] = parts;
  const key = encKeyBuffer();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

// ----- Masking ------------------------------------------------------------
export function maskKey(plain: string): string {
  const s = plain.trim();
  if (s.length <= 8) return s.slice(0, 2) + "…";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), check);
}