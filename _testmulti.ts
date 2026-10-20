import { createKeyRows } from "./src/lib/keys";
import { byId, deleteRows } from "./src/lib/store";

(async () => {
  const { ids } = await createKeyRows({
    provider: "groq",
    accountName: "temp multi",
    usageLimit: 1000,
    usagePeriod: "daily",
    apiKeys: [
      { key: "gsk_aaa111", name: "" },
      { key: "gsk_bbb222", name: "" },
      { key: "gsk_ccc333", name: "explicit acct" },
    ],
  } as any);
  console.log("ids:", ids);
  for (const id of ids) {
    const r: any = await byId("api_keys", id);
    console.log(` id=${id} name=${JSON.stringify(r?.account_name)} provider=${r?.provider} limit=${r?.usage_limit} period=${r?.usage_period}`);
  }
  await deleteRows("api_keys", { id: { in: ids } } as any);
  console.log("cleaned up:", (await byId("api_keys", ids[0])) === null);

  // single-key backward compat (the old shape still works)
  const one = await createKeyRows({ provider: "groq", accountName: "solo", apiKey: "gsk_solo_1" } as any);
  console.log("single id:", one.ids, "name:", JSON.stringify((await byId("api_keys", one.ids[0]))?.account_name));
  await deleteRows("api_keys", { id: { in: one.ids } } as any);
  console.log("cleaned up solo");
  process.exit(0);
})();
