import { rows } from "./src/lib/store";
import { byId } from "./src/lib/store";
import type { ApiKeyRow } from "./src/lib/keys";
import type { KeyModelRow } from "./src/lib/usage";

(async () => {
  const keys = await rows<ApiKeyRow>("api_keys", { disabled: 0, status: { neq: "dead" } }, { order: "id" });
  const models = await rows<KeyModelRow>("key_models", {}, { order: "id" });

  const prov = new Map<string, { tpd: number; tpm: number; rpd: number; rpm: number; n: number; names: Set<string> }>();
  for (const k of keys) {
    const ms = models.filter((m) => m.key_id === k.id && m.enabled);
    const p = prov.get(k.provider) ?? { tpd: 0, tpm: 0, rpd: 0, rpm: 0, n: 0, names: new Set<string>() };
    for (const m of ms) {
      p.tpd += m.token_limit || 0;
      p.tpm += m.tpm || 0;
      p.rpd += m.rpd || 0;
      p.rpm += m.rpm || 0;
      p.names.add(`${m.model}(tpd=${m.token_limit || 0},rpd=${m.rpd || 0},rpm=${m.rpm || 0},tpm=${m.tpm || 0})`);
    }
    p.n += ms.length;
    prov.set(k.provider, p);
  }
  const f = (n: number) => n.toLocaleString("en-US");
  for (const [name, p] of prov) {
    console.log(`\n${name}: ${p.n} model instances`);
    console.log(`  TPD=${f(p.tpd)}  RPD=${f(p.rpd)}  RPM=${f(p.rpm)}  TPM=${f(p.tpm)}`);
    for (const s of [...p.names].sort()) console.log(`   ${s}`);
  }
  process.exit(0);
})();
