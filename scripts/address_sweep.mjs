// Every address a person can type, bookmark or be sent, with nonsense in it: the answer
// must be the page (filters ignored), "not found" or a redirect, never the error screen,
// a 5xx, or a page that never finishes.
//
// Since reads fail loudly (lib/supabase/must), a value Postgres refuses for a typed column
// (a uuid, an enum, a date such as 2026-02-30) turned a stale bookmark or a link mangled by
// an email client into a crash, unless the page checks the value first (lib/ids). Two
// sweeps, both discovered from the file tree so a new route is covered without editing
// this file:
//
//   ids      every dynamic route ([id], [token], ...) with a malformed and an unknown id
//   filters  every signed-in page with junk in every search parameter any page reads
//
// A streamed error does not change the status or reach the HTML, so pass the server's log
// (`--log=`) as well: new ReadFailed or [observability] lines while a sweep ran are failures.
//
// Accounts come from .env.local, never this file (the repository is public):
//   SWEEP_ACCOUNTS   comma-separated emails of TEST accounts to sweep as (one per role)
//   SWEEP_PASSWORD   their shared password
// Without them it sweeps as the click-through account (CLICKTHROUGH_PASSWORD).
//
//   node scripts/address_sweep.mjs [--base=http://localhost:3111] [--log=server.log]
//                                  [--only=ids|filters] [--verbose]
import fs from "node:fs";
import path from "node:path";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const BASE = arg("base") ?? "http://localhost:3111";
const LOG = arg("log");
const ONLY = arg("only");
const VERBOSE = process.argv.includes("--verbose");

function readEnv(name) {
  if (process.env[name]) return process.env[name];
  if (!fs.existsSync(".env.local")) return null;
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}
const SUPABASE_URL = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON = readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
if (!SUPABASE_URL || !ANON) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are needed");
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];

const listed = (readEnv("SWEEP_ACCOUNTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ACCOUNTS = listed.length ? listed : ["clickthrough@fleetwise.test"];
const PASSWORD = listed.length ? readEnv("SWEEP_PASSWORD") : readEnv("CLICKTHROUGH_PASSWORD");
if (!PASSWORD) throw new Error(listed.length ? "SWEEP_PASSWORD is not set" : "CLICKTHROUGH_PASSWORD is not set");

/** A signed-in cookie for `email`, in the shape @supabase/ssr reads (chunked past ~3 kB). */
async function session(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!r.ok) return null;
  const s = await r.json();
  const value = "base64-" + Buffer.from(JSON.stringify({
    access_token: s.access_token, token_type: "bearer", expires_in: s.expires_in,
    expires_at: s.expires_at, refresh_token: s.refresh_token, user: s.user,
  })).toString("base64");
  const parts = [];
  for (let i = 0, n = 0; i < value.length; i += 3180, n += 1) parts.push([`sb-${ref}-auth-token.${n}`, value.slice(i, i + 3180)]);
  if (parts.length === 1) parts[0][0] = `sb-${ref}-auth-token`;
  return { cookie: parts.map(([k, v]) => `${k}=${v}`).join("; "), token: s.access_token };
}

// == What to visit, from the file tree ==========================================
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const appDir = path.join("src", "app");
const files = walk(appDir);
/** `src/app/(app)/machines/[id]/page.tsx` -> `/machines/[id]` (route groups dropped). */
const routeOf = (file) => "/" + path.relative(appDir, path.dirname(file)).split(path.sep).filter((s) => !/^\(.*\)$/.test(s)).join("/");
const endpoints = files.filter((f) => /[\\/](page\.tsx|route\.ts)$/.test(f));

const dynamicRoutes = [...new Set(endpoints.map(routeOf).filter((r) => r.includes("[")))].sort();
const signedInPages = [...new Set(
  endpoints
    .filter((f) => f.endsWith("page.tsx") && f.includes(`${path.sep}(app)${path.sep}`))
    .map(routeOf)
    .filter((r) => !r.includes("[")),
)].sort();
const paramNames = new Set();
for (const file of files.filter((f) => /\.(ts|tsx)$/.test(f))) {
  for (const m of fs.readFileSync(file, "utf8").matchAll(/\b(?:sp|raw)\.([a-zA-Z_]+)\b/g)) paramNames.add(m[1]);
}

const BAD_IDS = ["not-a-uuid", "00000000-0000-4000-8000-000000000000"];
const JUNK = ["not-a-value", "2026-13-45", "2026-02-30", "-1"];

// == Signals ======================================================================
const logSize = () => (LOG && fs.existsSync(LOG) ? fs.statSync(LOG).size : 0);
// Server-side failures only: `[observability] client:...` lines are reports a browser sent
// (another check running against the same server), and this sweep runs no browser. Read
// as bytes, because `logSize()` is a byte offset and the log has multi-byte characters.
const logLinesSince = (offset) => !LOG ? [] : fs.readFileSync(LOG).subarray(offset).toString("utf8")
  .split(/\r?\n/).filter((l) => /ReadFailed|\[observability\] (?!client:)/.test(l));

async function visit(cookie, url) {
  const started = Date.now();
  try {
    const r = await fetch(`${BASE}${url}`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(45_000) });
    let failed = r.status >= 500;
    if (r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/html")) {
      failed ||= (await r.text()).includes("data-error-boundary");
    } else {
      await r.arrayBuffer().catch(() => {});
    }
    return { status: r.status, failed, ms: Date.now() - started };
  } catch (error) {
    return { status: error?.name === "TimeoutError" ? "TIMEOUT" : `THREW(${error?.cause?.code ?? error?.name})`, failed: true, ms: Date.now() - started };
  }
}

function plan() {
  const urls = [];
  if (ONLY !== "filters") {
    for (const route of dynamicRoutes) for (const id of BAD_IDS) urls.push(["ids", route.replace(/\[[^\]]+\]/g, id)]);
  }
  if (ONLY !== "ids") {
    for (const page of signedInPages) for (const value of JUNK) {
      urls.push(["filters", `${page}?${new URLSearchParams([...paramNames].map((n) => [n, value]))}`]);
    }
  }
  return urls;
}

// == Run ==========================================================================
const urls = plan();
let problems = 0;
for (const email of ACCOUNTS) {
  const who = email.split("@")[0];
  const s = await session(email);
  if (!s) { console.log(`--  ${who}: could not sign in`); problems += 1; continue; }
  const failed = [];
  const from = logSize();
  try {
    for (const [sweep, url] of urls) {
      const v = await visit(s.cookie, url);
      if (VERBOSE) console.log(`  ${who} ${sweep} ${v.status} ${v.ms}ms ${url.slice(0, 100)}`);
      if (v.failed) failed.push(`${url.split("?")[0]}${sweep === "filters" ? ` [${new URL(url, BASE).searchParams.values().next().value}]` : ""} -> ${v.status}`);
    }
  } finally {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: ANON, authorization: `Bearer ${s.token}` } }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 500));
  const logged = [...new Set(logLinesSince(from))];
  problems += failed.length + logged.length;
  console.log(`${who.padEnd(14)} ${failed.length ? "FAILED: " + failed.join("  ") : "every address handled"}`);
  if (logged.length) console.log(`               server log:\n                 ${logged.slice(0, 30).join("\n                 ")}`);
}
console.log(`${dynamicRoutes.length} dynamic routes x ${BAD_IDS.length} ids, ${signedInPages.length} pages x ${JUNK.length} junk values (${paramNames.size} parameter names), ${ACCOUNTS.length} account(s)${LOG ? "" : "; no --log, so streamed errors were not seen"}`);
console.log(problems ? `${problems} problem(s)` : "no address crashed, hung or logged a failed read");
process.exitCode = problems ? 1 : 0;
