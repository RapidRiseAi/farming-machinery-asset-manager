import en from "../src/lib/i18n/en.json" with { type: "json" };
import af from "../src/lib/i18n/af.json" with { type: "json" };

function flat(o, p = "") {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flat(v, key));
    else out.push(key);
  }
  return out;
}
const e = new Set(flat(en));
const a = new Set(flat(af));
const missingInAf = [...e].filter((k) => !a.has(k));
const missingInEn = [...a].filter((k) => !e.has(k));
console.log(`en keys: ${e.size}, af keys: ${a.size}`);
if (missingInAf.length) console.log("MISSING IN AF:", missingInAf);
if (missingInEn.length) console.log("MISSING IN EN:", missingInEn);
if (missingInAf.length || missingInEn.length) process.exit(1);
console.log("PARITY OK");
