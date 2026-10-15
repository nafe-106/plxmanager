import { rows } from "./src/lib/store";
import { KAGGLE_API_BASE, accountApiKey, fetchQuota } from "./src/lib/kaggle";

async function raw(account: any): Promise<any> {
  const headers: Record<string, string> = { Accept: "application/json" };
  headers.Authorization = `Basic ${Buffer.from(`${account.username}:${accountApiKey(account)}`).toString("base64")}`;
  const res = await fetch(`${KAGGLE_API_BASE}/kernels/quota`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

(async () => {
  const accounts = await rows<any>("kaggle_accounts", {}, { order: "id" });
  for (const a of accounts) {
    try {
      const r = await raw(a);
      console.log(`\n=== ${a.username} (id ${a.id}) HTTP ${r.status} ===`);
      try {
        const j = JSON.parse(r.body);
        console.log(JSON.stringify(j, null, 2));
      } catch {
        console.log(r.body.slice(0, 500));
      }
      const q = await fetchQuota(a as any);
      console.log("parsed:", JSON.stringify(q));
    } catch (e: any) {
      console.log(`\n=== ${a.username} ERROR: ${e?.message || e}`);
    }
  }
  process.exit(0);
})();
