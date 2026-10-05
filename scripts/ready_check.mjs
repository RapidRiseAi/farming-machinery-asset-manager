#!/usr/bin/env node
/**
 * Buttons load until they work, checked in a real browser on a slow phone.
 *
 * == Why it exists ==========================================================
 * The server sends every page with its buttons drawn, and React attaches to them only
 * once the page's JavaScript has run: on the live site up to about 4 s on a desktop
 * connection, longer on a phone over rural mobile data. A tap in that gap used to vanish.
 * src/components/ui/boot-guard.ts now marks the page as starting before first paint
 * (`data-booting` on <html>), holds taps on controls while it is, and <BootReady/> takes
 * the mark off once every control works. This proves those promises on the production
 * bundle under a throttled phone profile, where the gap is widest.
 *
 * == What it asserts, per route =============================================
 *  1. The page arrives marked: the mark is on <html> once the HTML is parsed, and the
 *     controls are drawn as busy (cursor: progress, the pulse animation).
 *  2. A real tap on a control not yet attached is held while starting: a probe proves the
 *     event never got past the guard, and nothing navigated. On /login, signed out, typing
 *     an email and pressing Enter, and tapping Sign in, are held the same way.
 *  3. The mark comes off within the time limit, and only once every control is attached;
 *     for 1.5 s after it, nothing streamed in late appears unattached.
 *  4. It comes off promptly: within 500 ms of the last control attaching.
 *  5. Afterwards nothing is still drawn as starting.
 *
 *   node scripts/ready_check.mjs                       # against http://localhost:3111
 *   node scripts/ready_check.mjs --base=http://localhost:3000
 *   node scripts/ready_check.mjs --require             # fail, rather than skip, with no Chrome
 *
 * Needs the app running and a .env.local with the Supabase URL and anon key. Signs in as
 * the throwaway click-through owner, as ui_check.mjs does. Node 22 or later, for the
 * global WebSocket. Writes nothing: it taps only while the page is holding taps.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import os from "node:os";

const ROOT = process.cwd();
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const BASE = arg("base") ?? "http://localhost:3111";
const REQUIRE = process.argv.includes("--require");
const PORT = Number(arg("port") ?? 9467);
const CHROMES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const CHROME = CHROMES.find((p) => p && existsSync(p));
if (!CHROME) {
  const note = "ready_check: no Chrome found, skipping.";
  if (REQUIRE) {
    console.error(note.replace("skipping", "REQUIRED but cannot run"));
    process.exit(1);
  }
  console.log(note);
  process.exit(0);
}
const require = createRequire(join(ROOT, "package.json"));
createRequire(require.resolve("next/package.json"))("@next/env").loadEnvConfig(ROOT);

const TEST_MACHINE = "f0000000-0000-4000-8000-00000000aa01";
const SIGNED_IN = ["/dashboard", "/machines", `/machines/${TEST_MACHINE}`, "/assistant", "/jobcards", "/faults", "/settings"];
const ATTRIBUTE = "data-booting";
// Kept equal to BOOT_CONTROL_SELECTORS in src/components/ui/boot-guard.ts.
const CONTROLS = 'button,[role="button"],[role="tab"],[role="switch"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],input[type="checkbox"],input[type="radio"],input[type="submit"],input[type="button"],input[type="reset"],summary';
const SETTLE_LIMIT_MS = 500;
const CLEAR_TIMEOUT_MS = 45_000;

let failures = 0;
const check = (route, label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${route}  ${label}${detail ? `  (${detail})` : ""}`);
};
const note = (route, label) => console.log(`NOTE  ${route}  ${label}`);

// == Session for the repo's throwaway click-through owner (as ui_check.mjs does) ==
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "clickthrough@fleetwise.test", password: "Clickthrough!2026" }),
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

// == Chrome ==
const profile = mkdtempSync(join(os.tmpdir(), "fw-ready-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=360,780", "about:blank",
], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

let target;
for (let i = 0; i < 80 && !target; i += 1) {
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
  if (!target) await new Promise((r) => setTimeout(r, 250));
}
if (!target) throw new Error("Chrome never opened a debugging port");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
let mainNavigations = 0;
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Page.frameNavigated" && !msg.params.frame.parentId) mainNavigations += 1;
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return undefined;
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Installed before any page script runs. Records when the HTML finished parsing and
 * whether the mark was on then; the first moment every control was attached; and when
 * the mark came off, with any control still unattached at that moment.
 */
const PROBE = `(() => {
  const SEL = ${JSON.stringify(CONTROLS)};
  const p = window.__bootProbe = { dcl: null, flagAtDcl: null, controlsAtDcl: 0, hydratedAt: null, clearedAt: null, unattachedAtClear: null, seen: false, lateMax: 0, lateExample: null, lateDone: false, heldClicks: 0, leakedClicks: 0, heldSubmits: 0, leakedSubmits: 0 };
  const attached = (el) => Object.keys(el).some((k) => k.startsWith("__reactProps"));
  const unattached = () => [...SNAPSHOT()].filter((el) => !attached(el));
  // The server's own controls once parsed, as BootReady counts them; before that, all.
  function SNAPSHOT() { return window.__fwBootControls ? [...window.__fwBootControls].filter((el) => el.isConnected) : document.querySelectorAll(SEL); }
  // Proof that the guard held a tap, whatever the control does: window capture sees every
  // event first; window bubble sees only events nothing stopped on the way.
  const marked = () => Boolean(document.documentElement && document.documentElement.hasAttribute(${JSON.stringify(ATTRIBUTE)}));
  const expected = new WeakSet();
  addEventListener("click", (e) => {
    const k = e.target && e.target.closest ? e.target.closest(SEL) : null;
    const nativeLink = k && k.tagName === "A" && k.hasAttribute("href") && !k.hasAttribute("data-needs-js");
    if (marked() && k && !attached(k) && !nativeLink) { p.heldClicks += 1; expected.add(e); }
  }, true);
  addEventListener("click", (e) => { if (expected.has(e)) p.leakedClicks += 1; });
  addEventListener("submit", (e) => {
    const f = e.target;
    if (marked() && f && !attached(f) && (f.getAttribute("method") || "").toLowerCase() !== "get") { p.heldSubmits += 1; expected.add(e); }
  }, true);
  addEventListener("submit", (e) => { if (expected.has(e)) p.leakedSubmits += 1; });
  new MutationObserver(() => {
    const root = document.documentElement;
    if (!root) return;
    if (root.hasAttribute(${JSON.stringify(ATTRIBUTE)})) { p.seen = true; return; }
    if (p.seen && p.clearedAt === null) {
      p.clearedAt = performance.now();
      p.unattachedAtClear = unattached().map((el) => el.outerHTML.slice(0, 140));
      // For 1.5 s after the mark is gone, nothing may sit on screen unattached: content
      // streamed in late must not appear looking ready while it is not.
      const until = p.clearedAt + 1500;
      const watch = setInterval(() => {
        const late = unattached();
        if (late.length > p.lateMax) { p.lateMax = late.length; p.lateExample = late[0].outerHTML.slice(0, 140); }
        if (performance.now() > until) { clearInterval(watch); p.lateDone = true; }
      }, 50);
    }
  }).observe(document, { attributes: true, subtree: true, attributeFilter: [${JSON.stringify(ATTRIBUTE)}] });
  document.addEventListener("DOMContentLoaded", () => {
    p.dcl = performance.now();
    p.flagAtDcl = document.documentElement.hasAttribute(${JSON.stringify(ATTRIBUTE)});
    p.controlsAtDcl = document.querySelectorAll(SEL).length;
  });
  const timer = setInterval(() => {
    if (p.hydratedAt === null && document.readyState !== "loading") {
      const list = [...document.querySelectorAll(SEL)];
      if (list.length && list.every(attached)) p.hydratedAt = performance.now();
    }
    if (p.clearedAt !== null && p.hydratedAt !== null) clearInterval(timer);
  }, 25);
})()`;

/** The centre of the first visible, enabled control that is not a link, or null. */
const VISIBLE_CONTROL = `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(CONTROLS)})].find((b) => {
    if (b.disabled || b.closest("a[href]")) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
  });
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, cursor: s.cursor, animation: s.animationName, label: (el.innerText || el.getAttribute("aria-label") || el.tagName).replace(/\\s+/g, " ").trim().slice(0, 40) };
})()`;

const stillMarked = () => evaluate(`document.documentElement.hasAttribute(${JSON.stringify(ATTRIBUTE)})`);

/** Taps only while the page is still starting, so a tap can never land on a working control and do something. */
async function tap(point) {
  if (!(await stillMarked())) return false;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  }
}

async function pressEnterInEmail() {
  const focused = await evaluate(`(() => { const i = document.querySelector('form input[type=email], form input[name=email]'); if (!i) return false; i.focus(); return document.activeElement === i; })()`);
  if (!focused) return false;
  // A valid address, so the form's own validation cannot be what stops the submit.
  await send("Input.insertText", { text: "ready.check@fleetwise.test" });
  // Only while the page is still starting: once it works, Enter would really submit.
  if (!(await stillMarked())) return false;
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
  }
  return true;
}

async function checkRoute(path, { enterTest = false } = {}) {
  await send("Page.navigate", { url: "about:blank" });
  await sleep(150);
  await send("Network.clearBrowserCache");
  await send("Page.navigate", { url: `${BASE}${path}` });

  // 1. Arrives marked, controls drawn as busy.
  let probe;
  const started = Date.now();
  while (Date.now() - started < CLEAR_TIMEOUT_MS) {
    probe = await evaluate(`location.href !== "about:blank" && window.__bootProbe && window.__bootProbe.dcl !== null ? { ...window.__bootProbe, at: location.pathname } : null`);
    if (probe) break;
    await sleep(40);
  }
  if (!probe) return check(path, "page loaded", false, "the HTML never finished parsing");
  if (probe.at !== path.split("?")[0]) note(path, `redirected to ${probe.at}; checking that page`);
  check(path, "arrives marked as starting", probe.flagAtDcl === true, `${probe.controlsAtDcl} controls at parse`);

  // 2. A real tap, and on the form a real Enter and a tap on its submit button, while
  // starting are held: proven by the probe (the event never got past the guard), not just
  // by the absence of a navigation, which a plain button could never cause anyway.
  const stillStarting = await evaluate(`document.documentElement.hasAttribute(${JSON.stringify(ATTRIBUTE)})`);
  if (stillStarting) {
    const control = await evaluate(VISIBLE_CONTROL);
    if (control) {
      check(path, "controls are drawn as busy", control.cursor === "progress", `"${control.label}": cursor ${control.cursor}, animation ${control.animation}`);
      const before = { nav: mainNavigations, ...(await evaluate("({ c: __bootProbe.heldClicks, s: __bootProbe.heldSubmits })")) };
      await tap(control);
      let actions = `tapped "${control.label}"`;
      if (enterTest) {
        if (await pressEnterInEmail()) actions += ", typed an email and pressed Enter";
        else note(path, "no email field in a form to press Enter in");
        const submit = await evaluate(`(() => { const b = [...document.querySelectorAll('form button[type=submit], form button:not([type])')].find((el) => !el.hasAttribute('data-default-submit') && /sign in|meld aan/i.test(el.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        if (submit) { await tap(submit); actions += ", tapped Sign in"; }
      }
      await sleep(700);
      const after = await evaluate("({ c: __bootProbe.heldClicks, s: __bootProbe.heldSubmits, lc: __bootProbe.leakedClicks, ls: __bootProbe.leakedSubmits })");
      const held = (after.c - before.c) + (after.s - before.s);
      if (held > 0) {
        check(path, "taps while starting are held", after.lc === 0 && after.ls === 0 && mainNavigations === before.nav, `${actions}: ${held} held, ${after.lc + after.ls} got past the guard, ${mainNavigations - before.nav} navigation(s)`);
      } else note(path, `the control was already working when tapped (${actions}), hold not exercised`);
    } else note(path, "no visible control on screen while starting, tap not exercised");
  } else note(path, "the page was ready before it could be tapped, tap not exercised");

  // 3 and 4. Comes off, only once every control is attached, and promptly.
  while (Date.now() - started < CLEAR_TIMEOUT_MS) {
    probe = await evaluate("window.__bootProbe");
    if (probe?.clearedAt !== null && probe?.clearedAt !== undefined) break;
    await sleep(100);
  }
  if (probe?.clearedAt == null) return check(path, "the mark comes off", false, `still starting after ${CLEAR_TIMEOUT_MS / 1000} s`);
  const unattached = probe.unattachedAtClear ?? [];
  check(path, "comes off only once every control works", unattached.length === 0, unattached.length ? `${unattached.length} unattached, first: ${unattached[0]}` : `after ${Math.round(probe.clearedAt - probe.dcl)} ms past parse`);
  if (probe.hydratedAt !== null) {
    const lag = Math.round(probe.clearedAt - probe.hydratedAt);
    check(path, "comes off promptly once they do", lag <= SETTLE_LIMIT_MS, `${lag} ms after the last control attached`);
  }

  // 3b. Nothing streamed in afterwards appears unattached.
  for (let i = 0; i < 40 && !(probe?.lateDone); i += 1) {
    await sleep(100);
    probe = await evaluate("window.__bootProbe");
  }
  check(path, "nothing appears unattached after it comes off", (probe?.lateMax ?? 0) === 0, probe?.lateMax ? `${probe.lateMax} unattached, first: ${probe.lateExample}` : "watched 1.5 s");

  // 5. Nothing still drawn as starting.
  const after = await evaluate(`[...document.querySelectorAll(${JSON.stringify(CONTROLS)})].filter((el) => getComputedStyle(el).animationName.includes("fw-boot")).length`);
  check(path, "nothing is left drawn as starting", after === 0, after ? `${after} still pulsing` : "");
}

await send("Page.enable");
await send("Network.enable");
// After the first page the service worker would serve assets past the throttle; every
// route must load the way a first visit on a slow phone does.
await send("Network.setBypassServiceWorker", { bypass: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setCPUThrottlingRate", { rate: 6 });
await send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 90_000 });

console.log(`ready_check against ${BASE}, phone profile: CPU 6x slower, 150 ms latency, 200 KB/s down\n`);
for (const [name, value] of cookies) {
  await send("Network.setCookie", { name, value, domain: new URL(BASE).hostname, path: "/", secure: BASE.startsWith("https:") });
}
for (const path of SIGNED_IN) await checkRoute(path);

await send("Network.clearBrowserCookies");
await checkRoute("/login", { enterTest: true });

console.log(failures ? `\n${failures} check(s) failed.` : "\nEvery page arrived marked as starting, held taps while it was, and let go once its controls worked.");
cleanup();
process.exit(failures ? 1 : 0);
