import { NextResponse } from "next/server";
import { decrypt } from "@/lib/crypto";
import {
  resolveGeneralKeyFromRequest,
  pickProviderKey,
  logProxyUsage,
  upstreamUrl,
  upstreamHeaders,
  extractUsage,
  SseUsageCollector,
  gatewayInfo,
  mergedModelCatalog,
  modelsForRequest,
  splitGatewayModel,
  CORS_HEADERS,
} from "@/lib/general";

// OpenAI-compatible gateway. Clients talk to this app exactly like they talk
// to OpenAI, but authenticate with a general key (tam_gk_…):
//
//   base_url: <origin>/v1            (also reachable at <origin>/api/v1)
//   POST   /v1/chat/completions
//   POST   /v1/completions
//   POST   /v1/embeddings
//   GET    /v1/models
//
// Each request is forwarded to one underlying provider key chosen by
// usage-weighted round-robin. Streaming (SSE) is relayed chunk-by-chunk while
// usage is parsed from the final chunk for tracking.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function errorJson(status: number, message: string, type = "invalid_request_error"): Response {
  return cors(
    new Response(JSON.stringify({ error: { message, type, code: null } }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

type RouteCtx = { params: Promise<{ path?: string[] }> };

async function handle(req: Request, ctx: RouteCtx): Promise<Response> {
  const { path: segments = [] } = await ctx.params;
  const clientPath = segments.join("/");

  // Gateway info / health probe (no auth, like OpenAI's root).
  if (req.method === "GET" && !clientPath) {
    const host = new URL(req.url).origin;
    return cors(NextResponse.json(gatewayInfo(host)));
  }

  // GET /v1/models — merged catalog across all provider keys, OpenRouter-style.
  // Clients (OpenClaw etc.) list models before first chat call; be permissive:
  // respond when the key is valid OR the client sends none at all.
  if (req.method === "GET" && /^models\/?$/.test(clientPath)) {
    const gkProbe = resolveGeneralKeyFromRequest(req);
    if (!gkProbe && req.headers.get("authorization")) {
      return errorJson(401, "Invalid API key.", "authentication_error");
    }
    const models = await mergedModelCatalog();
    return cors(
      NextResponse.json({
        object: "list",
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: m.owned_by ?? "organization-owner",
          context_length: m.context_length,
        })),
      })
    );
  }

  const gk = resolveGeneralKeyFromRequest(req);
  if (!gk) {
    return errorJson(401, "Invalid or missing general API key. Send 'Authorization: Bearer tam_gk_…'.", "authentication_error");
  }

  // Read the body once so we can route on the model and forward it verbatim.
  let bodyText = "";
  if (req.method === "POST") {
    bodyText = await req.text();
    if (!bodyText) return errorJson(400, "Request body is required.");
  }
  let model = "";
  try {
    model = String(JSON.parse(bodyText || "{}")?.model ?? "");
  } catch {
    return errorJson(400, "Request body must be valid JSON.");
  }

  const maxAttempts = 2; // one retry on a different key if the first fails pre-response
  let lastError = "";

  // "groq/openai/gpt-oss-120b" → route to groq keys with "openai/gpt-oss-120b".
  const split = model ? splitGatewayModel(model) : null;
  const upstreamModel = split?.upstream || "";

  // Restrict to keys whose live model catalog actually serves this model
  // (falls back to all eligible keys when no catalog is reachable).
  const { keys: candidates } = await modelsForRequest(gk.id, model || undefined);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const picked = pickProviderKey(gk.id, upstreamModel || undefined, candidates);
    if (!picked) {
      return errorJson(
        model ? 404 : 503,
        model
          ? `No enabled API key can serve model '${model}'. Add the model to a key or clear its model list.`
          : "No enabled API keys available. Add or enable keys first.",
        model ? "model_not_found" : "service_unavailable"
      );
    }

    let plain = "";
    try {
      plain = decrypt(picked.row.api_key_enc);
    } catch {
      plain = "";
    }
    if (!plain) {
      lastError = "stored API key could not be decrypted";
      continue;
    }

    const upstream = upstreamUrl(picked.row.provider, picked.row.base_url, clientPath, plain);
    if (!upstream) {
      lastError = `provider '${picked.row.provider}' has no base URL configured`;
      continue;
    }

    // Forward the BARE model id upstream; the provider prefix is gateway-only.
    // Also normalize tool JSON schemas: Groq/Cerebras reject any object schema
    // lacking an explicit `additionalProperties:false`.
    let forwardBody = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      normalizeToolSchemas(parsed);
      if (upstreamModel && upstreamModel !== model) parsed.model = upstreamModel;
      forwardBody = JSON.stringify(parsed);
    } catch {
      // non-JSON body — forward verbatim
    }

    const headers = upstreamHeaders(picked.row.provider, plain, Buffer.byteLength(forwardBody));
    let res: Response;
    try {
      res = await fetch(upstream, {
        method: req.method,
        headers,
        body: req.method === "POST" ? forwardBody : undefined,
        signal: AbortSignal.timeout(300_000),
        redirect: "follow",
      });
    } catch (err: any) {
      lastError = err?.name === "TimeoutError" || err?.name === "AbortError" ? "upstream timeout" : err?.message || "upstream network error";
      continue; // try another key
    }

    // Retryable upstream failures (dead key, rate limit, provider 5xx).
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      lastError = `upstream HTTP ${res.status} from ${picked.row.provider}`;
      if (attempt < maxAttempts) continue;
    }

    return finish(req, res, gk.id, picked, upstreamModel || model);
  }

  return errorJson(502, `All routed keys failed. Last error: ${lastError || "unknown"}`, "bad_gateway");
}

// Relay the upstream response to the client and record usage on both the
// selected provider key and the general key.
async function finish(req: Request, res: Response, gkId: number, picked: { row: { id: number }; used: number; limit: number; ratio: number }, fallbackModel: string): Promise<Response> {
  const outHeaders = new Headers();
  const ct = res.headers.get("content-type") ?? "application/json";
  outHeaders.set("Content-Type", ct);
  for (const h of ["x-request-id", "openai-organization", "openai-processing-ms"]) {
    const v = res.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) outHeaders.set(k, v);
  const status = res.status;

  const isSse = ct.includes("text/event-stream");
  if (!isSse || !res.body) {
    // Buffered: parse usage, log, and pass the body straight through.
    return res.text().then((text) => {
      let tokens = 0;
      let model = fallbackModel;
      try {
        const parsed = extractUsage(JSON.parse(text));
        tokens = parsed.tokens;
        if (parsed.model) model = parsed.model;
      } catch {
        // upstream returned non-JSON — still count the hit
      }
      logProxyUsage(gkId, picked.row.id, tokens, model);
      return new Response(text, { status, headers: outHeaders });
    });
  }

  // Streaming: relay chunks as they arrive while collecting the final usage.
  const collector = new SseUsageCollector();
  const decoder = new TextDecoder();
  const stream = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        collector.feed(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        collector.feed(decoder.decode()); // flush decoder tail
        const model = collector.model || fallbackModel;
        logProxyUsage(gkId, picked.row.id, collector.tokens, model);
      },
    })
  );
  return new Response(stream, { status, headers: outHeaders });
}

// OpenClaw etc. forward tool schemas that Groq's agentic "compound" models
// reject: every object inside `parameters` needs an explicit
// `additionalProperties:false` AND a `required` array covering every property.
// We inject both recursively before forwarding. Standard models (gpt-oss,
// cerebras) tolerate additionalProperties:false fine; only compound gets the
// required-fill since it enforces OpenAI "strict function calling" rules.
function normalizeToolSchemas(body: { tools?: unknown; model?: unknown }): void {
  const tools = Array.isArray(body?.tools) ? body.tools : null;
  if (!tools) return;
  const fillRequired = String(body?.model ?? "").includes("compound");
  for (const t of tools as { function?: { parameters?: unknown } }[]) {
    const params = t?.function?.parameters;
    if (params && typeof params === "object") strictify(params as Record<string, unknown>, fillRequired);
  }
}

function strictify(node: Record<string, unknown>, fillRequired: boolean): void {
  if (!node || typeof node !== "object") return;
  const isSchema =
    node.type === "object" || (node.type === "array" && !!node.items) || "properties" in node;
  if (isSchema && !("additionalProperties" in node)) node.additionalProperties = false;
  if (
    fillRequired &&
    node.properties &&
    typeof node.properties === "object" &&
    Object.keys(node.properties).length > 0 &&
    node.type === "object"
  ) {
    const keys = Object.keys(node.properties as Record<string, unknown>);
    const req = new Set<string>(Array.isArray(node.required) ? (node.required as string[]) : []);
    for (const k of keys) req.add(k);
    node.required = [...req];
  }

  if (node.properties && typeof node.properties === "object") {
    for (const v of Object.values(node.properties)) {
      if (v && typeof v === "object") strictify(v as Record<string, unknown>, fillRequired);
    }
  }
  if (node.items && typeof node.items === "object") strictify(node.items as Record<string, unknown>, fillRequired);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const arr = node[key];
    if (Array.isArray(arr)) {
      for (const v of arr) {
        if (v && typeof v === "object") strictify(v as Record<string, unknown>, fillRequired);
      }
    }
  }
}

export async function GET(req: Request, ctx: RouteCtx): Promise<Response> {
  return handle(req, ctx);
}

export async function POST(req: Request, ctx: RouteCtx): Promise<Response> {
  return handle(req, ctx);
}

export async function OPTIONS(): Promise<Response> {
  return cors(new Response(null, { status: 204 }));
}
