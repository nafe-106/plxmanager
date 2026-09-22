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

function tokenOk(val: unknown): boolean {
  if (!val) return false;
  const expected = getSetting("plexus_token") || "PLEXUS_KAGGLE_2026";
  const bearer = process.env.USAGE_LOG_BEARER || "";
  return String(val) === expected || String(val) === bearer;
}

function authed(req: Request): boolean {
  const url = new URL(req.url);
  if (tokenOk(url.searchParams.get("token"))) return true;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return tokenOk(bearer);
}

export async function GET(req: Request) {
  if (!authed(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const zone = getSetting("timezone") || "Asia/Dhaka";
  const out = listKeys().map((k) => {
    let apiKey = "";
    try {
      apiKey = decrypt(k.api_key_enc);
    } catch {
      apiKey = "";
    }
    const enriched = withUsage(k, zone) as any;
    return {
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
    };
  });
  return NextResponse.json({ ok: true, count: out.length, keys: out });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const bodyToken = body.token;
  delete body.token;
  if (!authed(req) && !tokenOk(bodyToken)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { id } = createKeyRow(body);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}