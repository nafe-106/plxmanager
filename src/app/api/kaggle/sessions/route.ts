import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { rows, insertRow } from "@/lib/store";
import { getAccount, getSession, getPlexusMode, gpuRemainingHours, sessionRunDurationMs, kaggleOverview, refreshAllQuotas } from "@/lib/kaggle";
import { formatDuration } from "@/lib/format";

export async function GET() {
  const g = await guard();
  if (g) return g;
  await refreshAllQuotas().catch(() => {});
  const all = await rows<any>("kaggle_sessions", {}, { order: "id", asc: false });
  const sessions = [];
  for (const s of all) {
    const account = s.account_id ? await getAccount(s.account_id) : null;
    const remaining = account ? await gpuRemainingHours(account) : null;
    const mode = s.type === "plexus" ? await getPlexusMode(s.id) : null;
    // Prefer the mode recorded at push time; fall back to "account is out of
    // GPU" for sessions started before mode tracking existed.
    const noGpu =
      s.type === "plexus" &&
      s.status === "running" &&
      (mode === "cpu" || (mode === null && remaining !== null && remaining <= 0));
    sessions.push({
      ...s,
      duration: s.running_since ? formatDuration(sessionRunDurationMs(s as any) || 0) : null,
      account: account ? { id: account.id, label: account.label, username: account.username } : null,
      account_remaining_h: remaining,
      gpu_mode: mode,
      // Running without a GPU = CPU fallback.
      no_gpu: noGpu,
    });
  }
  return NextResponse.json({ sessions, overview: await kaggleOverview() });
}

export async function POST(req: Request) {
  const g = await guard();
  if (g) return g;
  const body = await req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  const account = await getAccount(accountId);
  if (!account) return NextResponse.json({ error: "account not found" }, { status: 400 });

  const slug = String(body.slug || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9._-]+$/.test(slug)) {
    return NextResponse.json({ error: "slug must be owner/notebook-name" }, { status: 400 });
  }

  const inserted = await insertRow<any>("kaggle_sessions", {
    account_id: accountId,
    slug,
    label: String(body.label || "").slice(0, 200),
    type: body.type === "plexus" ? "plexus" : "notebook",
    auto_switch: body.autoSwitch === false ? 0 : 1,
  });
  return NextResponse.json({ id: Number(inserted.id) }, { status: 201 });
}