/**
 * The service worker's cost on real page loads (B12). Hard-loads routes one after another in
 * one tab WITH the worker in control, as an installed app relaunched from a home screen does,
 * and records for each load when the document arrived and when the page came alive (the
 * <html data-booting> mark coming off). B12 was those times growing with every load: 26 s to
 * 57 s over twelve loads, flat with the worker bypassed (docs/BUILD_LOG.md, 2026-10-15).
 *
 *   node scripts/sw_check.mjs --base=http://localhost:3111 --routes=/tyres,/machines,/team --loads=12
 *   node scripts/sw_check.mjs ... --bypass          # the same with the worker bypassed
 *
 * Signs in as the click-through owner (CLICKTHROUGH_PASSWORD from .env.local). Run it against
 * a production build (pnpm build && pnpm start -p 3111): the worker registers only there.
 * A route that redirects for this person shows "arrived ?" because the address never matches.
 * The worker request count is best effort: it stops when Chrome restarts the worker.
 * Prints timings only, never a secret.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const arg = (name, d) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? d;
const BASE = arg("base", "http://localhost:3111");
const ROUTES = arg("routes", arg("route", "/tyres")).split(",");
let routeIndex = 0;
const LOADS = Number(arg("loads", "12"));
const IDLE_MS = Number(arg("idle", "3000"));
const BYPASS = process.argv.includes("--bypass");
const PORT = 9471;

const env = (n) => {
  for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === n) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
};
const SUPABASE_URL = env("NEXT_PUBLIC_SUPABASE_URL");
const ANON = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "clickthrough@fleetwise.test", password: env("CLICKTHROUGH_PASSWORD") }),
});
if (!auth.ok) throw new Error(`sign-in failed: ${auth.status}`);
const session = await auth.json();
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const encoded = "base64-" + Buffer.from(JSON.stringify({
  access_token: session.access_token, token_type: "bearer", expires_in: session.expires_in,
  expires_at: session.expires_at, refresh_token: session.refresh_token, user: session.user,
}), "utf8").toString("base64");
const cookies = [];
for (let i = 0, n = 0; i < encoded.length; i += 3180, n += 1) cookies.push([`sb-${ref}-auth-token.${n}`, encoded.slice(i, i + 3180)]);
if (cookies.length === 1) cookies[0][0] = `sb-${ref}-auth-token`;

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")].find((p) => existsSync(p));
const profile = mkdtempSync(join(os.tmpdir(), "fw-b12-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=390,844", "about:blank"], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

let browserWs;
for (let i = 0; i < 80 && !browserWs; i += 1) {
  try { browserWs = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
  if (!browserWs) await new Promise((r) => setTimeout(r, 250));
}
const ws = new WebSocket(browserWs);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
const swRequests = { total: 0, navigations: 0, inFlight: new Set(), maxInFlight: 0 };
let swSession = null;
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "service_worker") {
    swSession = msg.params.sessionId;
    send("Network.enable", {}, swSession).catch(() => {});
    send("Runtime.runIfWaitingForDebugger", {}, swSession).catch(() => {});
  }
  if (msg.sessionId && msg.sessionId === swSession) {
    if (msg.method === "Network.requestWillBeSent") {
      swRequests.total += 1;
      if (msg.params.type === "Document" || /\/(?!_next)[^.]*$/.test(new URL(msg.params.request.url).pathname)) swRequests.navigations += 1;
      swRequests.inFlight.add(msg.params.requestId);
      swRequests.maxInFlight = Math.max(swRequests.maxInFlight, swRequests.inFlight.size);
    }
    if (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed") swRequests.inFlight.delete(msg.params.requestId);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send("Target.setDiscoverTargets", { discover: true });
const { targetInfos } = await send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page");
const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable");
await S("Runtime.enable");
await S("Network.enable");
if (BYPASS) await S("Network.setBypassServiceWorker", { bypass: true });
for (const [name, value] of cookies) await S("Network.setCookie", { name, value, domain: new URL(BASE).hostname, path: "/" });
const evaluate = async (expression) => {
  const r = await S("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.exceptionDetails ? undefined : r.result.value;
};

async function load(label) {
  const t0 = Date.now();
  const route = ROUTES[routeIndex++ % ROUTES.length];
  await S("Page.navigate", { url: BASE + route });
  // Wait for the document, then for the boot mark to come off (hydrated), up to 30 s.
  let parsed = false;
  let parsedMs = null;
  for (let i = 0; i < 400 && !parsed; i += 1) { parsed = (await evaluate("document.readyState !== 'loading' && !!document.documentElement && location.pathname === " + JSON.stringify(route))) === true; if (!parsed) await sleep(50); }
  if (parsed) parsedMs = Date.now() - t0;
  let hydratedMs = null;
  for (let i = 0; i < 300; i += 1) {
    const booting = await evaluate("document.documentElement.hasAttribute('data-booting')");
    if (booting === false) { hydratedMs = Date.now() - t0; break; }
    await sleep(100);
  }
  const controlled = await evaluate("!!(navigator.serviceWorker && navigator.serviceWorker.controller)");
  console.log(`${label.padEnd(8)} ${route.padEnd(14)} arrived ${parsedMs ?? "?"} ms, alive ${hydratedMs === null ? "NEVER (30 s)" : `${hydratedMs} ms (+${hydratedMs - (parsedMs ?? 0)} on the device)`}  sw-controlled ${controlled}  sw-requests ${swRequests.total} (pages ${swRequests.navigations}, in flight now ${swRequests.inFlight.size}, max ${swRequests.maxInFlight})`);
  return hydratedMs;
}

console.log(`B12 repro: ${BASE} ${ROUTES.join(" ")}, ${LOADS} loads, ${IDLE_MS} ms idle between, service worker ${BYPASS ? "BYPASSED" : "in control"}`);
await load("warm-up");
await sleep(IDLE_MS);
let never = 0;
for (let n = 1; n <= LOADS; n += 1) {
  const ms = await load(`load ${n}`);
  if (ms === null) never += 1;
  await sleep(IDLE_MS);
}
console.log(never ? `${never} load(s) never hydrated` : "every load hydrated");
cleanup();
process.exit(0);
