import { NextResponse } from "next/server";
import { fetchPlexusUrl } from "@/lib/kaggle";
import { getSetting } from "@/lib/settings";

// Stable gateway to the Plexus GPU tunnel.
//
// The Cloudflare quick-tunnel hostname changes on every restart, so external
// tools can't hardcode it. This route reads the CURRENT tunnel URL from the
// plexus_endpoint row (published by the notebook's keep-alive) and forwards
// the request there. Clients configure ONE permanent base URL forever:
//
//   https://plxmanager.vercel.app/api/plexus
//   Authorization: Bearer <plexus_token>
//
// Any Ollama or OpenAI-style path works: /api/tags, /api/chat,
// /v1/models, /v1/chat/completions, ...

let cached: { url: string; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

async function currentTunnelUrl(): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.url;
  const raw = await fetchPlexusUrl();
  if (!raw) {
    cached = null;
    return null;
  }
  const url = raw.replace(/\/+$/, "");
  cached = { url, at: Date.now() };
  return url;
}

async function authed(req: Request): Promise<boolean> {
  const expected = (await getSetting("plexus_token")) || "PLEXUS_KAGGLE_2026";
  const query = new URL(req.url).searchParams.get("token");
  if (query && query === expected) return true;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return bearer === expected;
}

async function handler(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<NextResponse> {
  if (!(await authed(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const base = await currentTunnelUrl();
  if (!base) {
    return NextResponse.json({ error: "tunnel_not_available" }, { status: 503 });
  }

  const { path } = await ctx.params;
  const pathname = path && path.length ? `/${path.join("/")}` : "";
  const query = new URL(req.url).searchParams.toString();
  const target = `${base}${pathname}${query ? "?" + query : ""}`;

  const token = (await getSetting("plexus_token")) || "PLEXUS_KAGGLE_2026";
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body: BodyInit | undefined = hasBody ? await req.arrayBuffer() : undefined;

  const modelForwarded = /\/api\/(chat|generate)\/?$|\/v1\/(chat\/completions|completions|embeddings|audio\/speech|audio\/transcriptions|audio\/translations|moderations)\/?$/;
  if (
    hasBody &&
    modelForwarded.test(pathname) &&
    (req.headers.get("content-type") || "").includes("application/json") &&
    body &&
    (body as ArrayBuffer).byteLength > 0
  ) {
    const buf = body as ArrayBuffer;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(buf));
      const model = parsed?.model;
      if (typeof model === "string" && model.includes("/")) {
        parsed.model = model.split("/").pop();
        body = new TextEncoder().encode(JSON.stringify(parsed)).buffer;
      }
    } catch {
      // leave the body untouched if it isn't parseable JSON
    }
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        Authorization: req.headers.get("authorization") || `Bearer ${token}`,
        "Content-Type": req.headers.get("content-type") || "application/json",
        Accept: req.headers.get("accept") || "application/json",
      },
      body,
      signal: AbortSignal.timeout(600_000),
    });
    if (!upstream.body) {
      return new NextResponse(null, { status: upstream.status });
    }
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err: any) {
    const msgOr =
      err?.cause?.code ||
      err?.cause?.message ||
      err?.name === "TimeoutError"
        ? "timeout"
        : err?.message || "tunnel unreachable";
    const msg = err?.name === "TimeoutError" ? "timeout" : String(msgOr);
    return NextResponse.json({ error: `tunnel_unreachable: ${msg}` }, { status: 502 });
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;