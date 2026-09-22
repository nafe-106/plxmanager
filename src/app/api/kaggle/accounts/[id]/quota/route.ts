import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { getAccount, refreshAccountQuota } from "@/lib/kaggle";

// POST /api/kaggle/accounts/[id]/quota
// Force-fetch the real weekly GPU quota from Kaggle (POST /kernels/quota) for
// one account and return the fresh numbers. Falls back to the last snapshot.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const account = await getAccount(Number(id));
  if (!account) return NextResponse.json({ error: "not found" }, { status: 404 });

  const quota = await refreshAccountQuota(account.id, true);
  if (!quota || !(quota.totalHours > 0)) {
    return NextResponse.json({ error: "Kaggle did not return GPU quota data (check credentials/account)" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, quota });
}