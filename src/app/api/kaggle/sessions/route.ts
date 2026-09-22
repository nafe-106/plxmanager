import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { rows, insertRow } from "@/lib/store";
import { getAccount, getSession, gpuRemainingHours, formatDuration, sessionRunDurationMs, kaggleOverview } from "@/lib/kaggle";

export async function GET() {
  const g = await guard();
  if (g) return g;
  const all = await rows<any>("kaggle_sessions", {}, { order: "id", asc: false });
  const sessions = [];
  for (const s of all) {
    const account = s.account_id ? await getAccount(s.account_id) : null;
    sessions.push({
      ...s,
      duration: s.running_since ? formatDuration(sessionRunDurationMs(s as any) || 0) : null,
      account: account ? { id: account.id, label: account.label, username: account.username } : null,
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