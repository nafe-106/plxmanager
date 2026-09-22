import { NextResponse } from "next/server";
import { byId } from "@/lib/store";
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
  const expected = process.env.USAGE_LOG_BEARER || "tam-cf5b87ee02fc237b09e1756a892f63c84227c5eb05ccbb21";
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const keyId = Number(body.keyId);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return NextResponse.json({ error: "keyId is required" }, { status: 400 });
  }
  const key = await byId<{ id: number }>("api_keys", keyId);
  if (!key) {
    return NextResponse.json({ error: "key not found" }, { status: 404 });
  }

  const tokens = Math.max(0, Number(body.tokens) || 0);
  const success = body.success !== false;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 200) : undefined;
  await logUsage(keyId, tokens, success, await timezone(), model);
  return NextResponse.json({ ok: true });
}