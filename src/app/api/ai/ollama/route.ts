import { NextResponse } from "next/server";
import { decrypt } from "@/lib/crypto";
import { listKeys, withUsage, createKeyRow } from "@/lib/keys";
import { getSetting } from "@/lib/settings";

// Compatibility bridge for the Ollama/Kaggle automation. The notebook pings
// this endpoint on startup. It is NOT the app's primary API.
//
//   GET  /api/ai/ollama?token=<PLEXUS_TOKEN>
//        -> { ok, keys: [{ id, provider, accountName, apiKey, baseUrl, models }] }
//   POST /api/ai/ollama   (same JSON as POST /api/keys, plus optional token)
//        -> created key

async function tokenOk(val: unknown): Promise<boolean> {
  if (!val) return false;
  const expected = (await getSetting("plexus_token")) || "PLEXUS_KAGGLE_2026";
  const bearer = process.env.USAGE_LOG_BEARER || "";
  return String(val) === expected || String(val) === bearer;
}

async function authed(req: Request): Promise<boolean> {
  const url = new URL(req.url);
  if (await tokenOk(url.searchParams.get("token"))) return true;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return tokenOk(bearer);
}

export async function GET(req: Request) {
  if (!(await authed(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const zone = (await getSetting("timezone")) || "Asia/Dhaka";
  const keysRows = await listKeys();
  const out = [];
  for (const k of keysRows) {
    let apiKey = "";
    try {
      apiKey = decrypt(k.api_key_enc);
    } catch {
      apiKey = "";
    }
    const enriched = (await withUsage(k, zone)) as any;
    out.push({
      id: k.id,
      provider: k.provider,
      accountName: k.account_name,
      apiKey,
      baseUrl: k.base_url || "",
      disabled: !!k.disabled,
      status: k.status,
      usage_limit: k.usage_limit,
      usage_period: k.usage_period,
      models: (enriched.models || []).map((m: any) => ({
        model: m.model,
        tokenLimit: m.tokenLimit,
        period: m.period,
        usage_hour: m.usage_hour,
        rpm: m.rpm,
        rpd: m.rpd,
        tpm: m.tpm,
        enabled: !!m.enabled,
        tokensToday: m.tokensToday,
        hitsToday: m.hitsToday,
        pct: m.pct,
        reqPct: m.reqPct,
      })),
    });
  }
  return NextResponse.json({ ok: true, count: out.length, keys: out });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bodyToken = body.token;
  delete body.token;
  if (!(await authed(req)) && !(await tokenOk(bodyToken))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { id } = await createKeyRow(body);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}