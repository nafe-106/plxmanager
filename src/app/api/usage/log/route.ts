import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { logUsage } from "@/lib/usage";
import { timezone } from "@/lib/settings";

/**
 * POST /api/usage/log
 *
 * Call this from your own scripts after each request to your models.
 * Protected by the USAGE_LOG_BEARER token (env).
 *
 * Body:  { "keyId": 1, "tokens": 123, "success": true }
 *
 * - keyId:   api_keys.id from the dashboard
 * - tokens:  tokens used by this request (0 allowed)
 * - success: whether the request succeeded ("false" counts as a hit but no tokens)
 */
export async function POST(req: Request) {
  const expected = process.env.USAGE_LOG_BEARER || "tam-usage-log-token";
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const keyId = Number(body.keyId);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return NextResponse.json({ error: "keyId is required" }, { status: 400 });
  }
  const key = db.prepare("SELECT id FROM api_keys WHERE id = ?").get(keyId) as { id: number } | undefined;
  if (!key) {
    return NextResponse.json({ error: "key not found" }, { status: 404 });
  }

  const tokens = Math.max(0, Number(body.tokens) || 0);
  const success = body.success !== false;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 200) : undefined;
  logUsage(keyId, tokens, success, timezone(), model);
  return NextResponse.json({ ok: true });
}