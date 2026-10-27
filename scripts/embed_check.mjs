// Every PostgREST select with an embedded relation, asked of the live API with limit=0:
// read-only, returns no rows, but an ambiguous embed (PGRST201) or one PostgREST cannot
// resolve (PGRST200) fails at once. The database tests run on PGlite, which has no
// PostgREST, so this class of bug was invisible until reads stopped swallowing errors.
// Uses the service key from .env.local (never printed) so row-level security plays no part.
import fs from "node:fs";
import path from "node:path";

const env = (n) => {
  for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === n) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
};
const URL_ = env("NEXT_PUBLIC_SUPABASE_URL");
const KEY = env("SUPABASE_SERVICE_ROLE_KEY");
if (!KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing from .env.local");

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });

const pairs = new Map();
for (const file of walk("src")) {
  const text = fs.readFileSync(file, "utf8");
  const re = /\.from\(\s*"([a-z_]+)"\s*\)\s*\.select\(\s*(["'`])([^"'`]*\([^"'`]*)\2/g;
  let m;
  while ((m = re.exec(text))) {
    const [, table, , select] = m;
    if (select.includes("${")) continue;
    const key = `${table}|${select.replace(/\s+/g, " ").trim()}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(`${file.split(path.sep).join("/")}:${text.slice(0, m.index).split("\n").length}`);
  }
}

let broken = 0;
for (const [key, where] of pairs) {
  const [table, select] = key.split("|");
  const r = await fetch(`${URL_}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=0`, {
    headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) {
    broken += 1;
    const body = await r.json().catch(() => ({}));
    console.log(`BROKEN ${r.status} ${body.code ?? ""}  ${table}: ${select.slice(0, 90)}\n   ${where.join("\n   ")}\n   ${(body.message ?? "").slice(0, 200)}`);
  } else {
    await r.arrayBuffer();
  }
}
console.log(`${pairs.size} embedded selects checked, ${broken} broken`);
