import { NextResponse } from "next/server";
import { guard } from "@/lib/auth";
import { byId } from "@/lib/store";
import { listAccountNotebooks } from "@/lib/kaggle";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guard();
  if (g) return g;
  const { id } = await ctx.params;
  const account = await byId<any>("kaggle_accounts", Number(id));
  if (!account) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const notebooks = await listAccountNotebooks(account);
    return NextResponse.json({ notebooks });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "failed to list notebooks" }, { status: 502 });
  }
}