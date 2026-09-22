import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { db } from "@/lib/db";
import { getAccount, gpuRemainingHours, gpuUsedHoursThisWeek, weeklyGpuHistory, getSession, formatDuration, sessionRunDurationMs, kaggleOverview } from "@/lib/kaggle";

export async function GET() {
  const g = await guard();
  if (g) return g;
  const sessions = (db.prepare("SELECT * FROM kaggle_sessions ORDER BY id DESC").all() as any[]).map(
    (s) => {
      const account = s.account_id ? getAccount(s.account_id) : null;
      return {
        ...s,
        duration: s.running_since ? formatDuration(sessionRunDurationMs(s as any) || 0) : null,
        account: account
          ? { id: account.id, label: account.label, username: account.username }
          : null,
      };
    }
  );
  return NextResponse.json({ sessions, overview: kaggleOverview() });
}

export async function POST(req: Request) {
  const g = await guard();
  if (g) return g;
  const body = await req.json().catch(() => ({}));
  const accountId = Number(body.accountId);
  const account = getAccount(accountId);
  if (!account) return NextResponse.json({ error: "account not found" }, { status: 400 });

  const slug = String(body.slug || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9._-]+$/.test(slug)) {
    return NextResponse.json({ error: "slug must be owner/notebook-name" }, { status: 400 });
  }

  const info = db
    .prepare(
      `INSERT INTO kaggle_sessions(account_id, slug, label, type, auto_switch) VALUES(?, ?, ?, ?, ?)`
    )
    .run(
      accountId,
      slug,
      String(body.label || "").slice(0, 200),
      body.type === "plexus" ? "plexus" : "notebook",
      body.autoSwitch === false ? 0 : 1
    );
  return NextResponse.json({ id: Number(info.lastInsertRowid) }, { status: 201 });
}