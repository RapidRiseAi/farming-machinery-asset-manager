/**
 * Repeated taps must do the work once, and failures must reach the person and the error
 * feed. Drives a real Chrome with real (CDP-dispatched) taps, on a CPU slowed like a cheap
 * phone, and counts what actually reached the server:
 *
 *   1. five quick taps on a report's CSV download: one request, one file;
 *   2. the same download failing (500) and refused (401): a sentence on screen, the 500
 *      reported to /api/observability, no file;
 *   3. an error thrown in a timer and a promise nobody caught: both reported;
 *   4. five quick taps on a server-action row (opening a notification): one post;
 *   5. a dialog mid-save ignores Escape and Close, sends one save, and closes when done;
 *   6. a save whose answer is lost, sent again after a reload, is saved once.
 *
 *   node scripts/spam_check.mjs --base=http://localhost:3111
 *
 * Signs in as the click-through owner (CLICKTHROUGH_PASSWORD from .env.local) and writes
 * nothing except marking one of that test farm's notifications read, saving one of its
 * preferences unchanged, and one marked fuel delivery it removes again. Run it against a
 * production build (pnpm build && pnpm start -p 3111). Prints counts only, never a secret.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const arg = (name, d) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? d;
const BASE = arg("base", "http://localhost:3111");
const THROTTLE = Number(arg("throttle", "4"));
const PORT = 9472;

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
const profile = mkdtempSync(join(os.tmpdir(), "fw-spam-"));
const downloads = mkdtempSync(join(os.tmpdir(), "fw-spam-dl-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=390,844", "about:blank"], { stdio: "ignore" });
const cleanup = () => {
  try { chrome.kill(); } catch {}
  for (const dir of [profile, downloads]) try { rmSync(dir, { recursive: true, force: true }); } catch {}
};
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
const listeners = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  for (const listener of listeners) listener(msg);
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { targetInfos } = await send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page");
const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable");
await S("Runtime.enable");
await S("Network.enable");
await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
for (const [name, value] of cookies) await S("Network.setCookie", { name, value, domain: new URL(BASE).hostname, path: "/" });
await S("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

// What reached the network, and what Chrome saved.
const requests = [];
let downloadsBegun = 0;
let intercept = null; // (params) => fulfil options, while a failure is being simulated
listeners.push((msg) => {
  if (msg.method === "Network.requestWillBeSent" && msg.sessionId === sessionId) {
    const r = msg.params.request;
    requests.push({ url: r.url, method: r.method, action: !!(r.headers["Next-Action"] || r.headers["next-action"]), body: r.postData ?? "" });
  }
  if (msg.method === "Browser.downloadWillBegin") downloadsBegun += 1;
  if (msg.method === "Fetch.requestPaused" && msg.sessionId === sessionId) {
    const answer = intercept?.(msg.params);
    const go = () => S("Fetch.continueRequest", { requestId: msg.params.requestId }).catch(() => {});
    if (answer?.fail) S("Fetch.failRequest", { requestId: msg.params.requestId, errorReason: answer.fail }).catch(() => {});
    else if (answer?.holdMs) setTimeout(go, answer.holdMs);
    else if (answer) S("Fetch.fulfillRequest", { requestId: msg.params.requestId, ...answer }).catch(() => {});
    else go();
  }
});

const evaluate = async (expression) => {
  const r = await S("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.exceptionDetails ? undefined : r.result.value;
};

async function open(path) {
  await S("Page.navigate", { url: BASE + path });
  for (let i = 0; i < 300; i += 1) {
    const ready = await evaluate(`location.pathname === ${JSON.stringify(path.split("?")[0])} && document.readyState !== "loading" && !document.documentElement.hasAttribute("data-booting")`);
    if (ready) break;
    await sleep(100);
  }
  await evaluate(`localStorage.setItem("farmgear:tour-done", "1")`);
}

/** Centre of the first element matching `selector` once React has attached to it. */
async function target(selector) {
  for (let i = 0; i < 100; i += 1) {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || !Object.keys(el).some((k) => k.startsWith("__react"))) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (box) return box;
    await sleep(100);
  }
  return null;
}

/** `times` real taps, `gap` ms apart: a person tapping again because nothing seems to happen. */
async function tap(box, times = 1, gap = 120) {
  for (let i = 0; i < times; i += 1) {
    await S("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await S("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    if (i < times - 1) await sleep(gap);
  }
}

const noticeText = () => evaluate(`[...document.querySelectorAll('body > div [role="alert"], body > div [role="status"]')].map((n) => n.textContent).join(" | ")`);
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

console.log(`spam check: ${BASE}, CPU slowed ${THROTTLE}x`);

// 1. Five taps on one CSV download.
await open("/reports");
const csv = 'a[href^="/reports/cost.csv"]';
const csvBox = await target(csv);
check(!!csvBox, "the cost CSV link is on /reports and attached");
if (csvBox) {
  const before = requests.length;
  const begunBefore = downloadsBegun;
  await tap(csvBox, 5);
  await sleep(8000);
  const sent = requests.slice(before).filter((r) => r.url.includes("/reports/cost.csv")).length;
  check(sent === 1, "five taps on a download send one request", `${sent} sent`);
  check(downloadsBegun - begunBefore === 1, "five taps on a download save one file", `${downloadsBegun - begunBefore} saved`);
}

// 2. The download failing, then refused.
await S("Fetch.enable", { patterns: [{ urlPattern: "*cost.csv*", requestStage: "Request" }] });
for (const [status, expect, reported] of [[500, "did not download", true], [401, "signed out", false]]) {
  await sleep(1600); // past the link's cool-down after the last save
  intercept = () => ({ responseCode: status, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from('{"error":"x"}').toString("base64") });
  const before = requests.length;
  const begunBefore = downloadsBegun;
  const box = await target(csv);
  await tap(box, 3);
  await sleep(2500);
  const text = (await noticeText()) ?? "";
  const reports = requests.slice(before).filter((r) => r.url.endsWith("/api/observability")).length;
  check(text.includes(expect), `a ${status} download says so on screen`, text.slice(0, 90) || "nothing shown");
  check(downloadsBegun === begunBefore, `a ${status} download saves no file`);
  check(reported ? reports >= 1 : reports === 0, `a ${status} download is ${reported ? "" : "not "}reported`, `${reports} report(s)`);
  intercept = null;
  // Dismiss so the next check reads a fresh notice.
  await evaluate(`[...document.querySelectorAll('body > div [role="alert"] button')].forEach((b) => b.click())`);
}
await S("Fetch.disable");

// 3. Errors outside rendering.
{
  const before = requests.length;
  await evaluate(`setTimeout(() => { throw new Error("spam_check probe: thrown in a timer"); }, 0); Promise.reject(new Error("spam_check probe: nobody caught this")); true`);
  await sleep(2500);
  const bodies = requests.slice(before).filter((r) => r.url.endsWith("/api/observability")).map((r) => r.body);
  check(bodies.some((b) => b.includes("thrown in a timer") && b.includes("window-error")), "an error thrown in a timer is reported");
  check(bodies.some((b) => b.includes("nobody caught this") && b.includes("unhandled-rejection")), "a promise nobody caught is reported");
}

// 4. Five taps on a server-action row.
await open("/notifications");
const rowSelector = 'main form:has(input[name="id"]) button[type="submit"]';
const row = await target(rowSelector);
if (!row) {
  console.log("SKIP  no notification row that opens a page on this farm");
} else {
  const before = requests.length;
  await tap(row, 5, 90);
  await sleep(6000);
  const posts = requests.slice(before).filter((r) => r.method === "POST" && r.action).length;
  check(posts === 1, "five taps on a server-action row send one post", `${posts} sent`);
}

// 5. A dialog cannot be closed mid-save (closing used to unmount the form, and reopening
// gave a fresh, unlocked Save). Saves the click-through owner's first preference unchanged,
// on a slowed connection so the save is still out while Escape and Close are tried.
await open("/account");
// The first dialog with a form in it (the page also has "What is this?" info dialogs).
let save = null;
const triggers = (await evaluate(`document.querySelectorAll('main button[aria-haspopup="dialog"]').length`)) ?? 0;
for (let i = 0; i < Math.min(triggers, 6) && !save; i += 1) {
  const box = await target(`main button[aria-haspopup="dialog"]:nth-of-type(1)`) && (await evaluate(`(() => { const b = document.querySelectorAll('main button[aria-haspopup="dialog"]')[${i}]; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`));
  if (!box) break;
  await tap(box);
  await sleep(1200);
  if (await evaluate(`!!document.querySelector('[role="dialog"] form button[type="submit"]')`)) {
    save = await target('[role="dialog"] form button[type="submit"]:last-of-type');
  } else {
    await S("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await S("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(500);
  }
}
if (!triggers) {
  console.log("SKIP  no dialog on /account");
} else {
  if (!save) {
    check(false, "the preference dialog opens with a Save button");
  } else {
    // Hold the save on the wire for 3 s, as a slow farm connection would.
    await S("Fetch.enable", { patterns: [{ urlPattern: "*/account*", requestStage: "Request" }] });
    intercept = (params) => (params.request.method === "POST" ? { holdMs: 3000 } : null);
    const before = requests.length;
    await tap(save);
    await sleep(300);
    await S("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await S("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    const closeBox = await evaluate(`(() => { const b = [...document.querySelectorAll('[role="dialog"] button[type="button"]')][0]; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (closeBox) await tap(closeBox);
    await sleep(300);
    const stillOpen = await evaluate(`!!document.querySelector('[role="dialog"]')`);
    check(stillOpen === true, "Escape and Close do nothing while the dialog is saving");
    await tap(save, 3, 100);
    await sleep(9000);
    intercept = null;
    await S("Fetch.disable");
    const posts = requests.slice(before).filter((r) => r.method === "POST" && r.action).length;
    check(posts === 1, "one save however the dialog is poked mid-save", `${posts} sent`);
    const closed = await evaluate(`!document.querySelector('[role="dialog"]')`);
    check(closed === true, "the dialog closes once the save has settled");
  }
}

// 6. A save whose answer is lost, sent again after a reload, is saved once (request_claims).
// Logs one fuel delivery on the click-through farm, marked by its invoice number, lets the
// request reach the server and kills the answer, reloads, sends the same entry again, and
// counts the rows. Removes the delivery afterwards when the farm allows it.
{
  const marker = `SPAMCHECK-${Date.now()}`;
  const openDelivery = async () => {
    await open("/fuel");
    const count = (await evaluate(`document.querySelectorAll('main button[aria-haspopup="dialog"], header button[aria-haspopup="dialog"]').length`)) ?? 0;
    for (let i = 0; i < Math.min(count, 8); i += 1) {
      const box = await evaluate(`(() => { const b = document.querySelectorAll('main button[aria-haspopup="dialog"], header button[aria-haspopup="dialog"]')[${i}]; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await tap(box);
      await sleep(1200);
      if (await evaluate(`!!document.querySelector('[role="dialog"] input[name="invoice_no"]')`)) return true;
      await S("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(400);
    }
    return false;
  };
  const fill = () => evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); d.querySelector('input[name="litres"]').value = "12.5"; d.querySelector('input[name="invoice_no"]').value = ${JSON.stringify(marker)}; return true; })()`);
  const rows = async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/fuel_deliveries?invoice_no=eq.${marker}&select=id`, {
      headers: { apikey: ANON, authorization: `Bearer ${session.access_token}` },
    });
    return r.ok ? (await r.json()).map((row) => row.id) : null;
  };
  if (!(await openDelivery())) {
    console.log("SKIP  no fuel delivery dialog on this farm");
  } else {
    await fill();
    await S("Fetch.enable", { patterns: [{ urlPattern: "*/fuel*", requestStage: "Response" }] });
    intercept = (params) => (params.request.method === "POST" ? { fail: "ConnectionReset" } : null);
    await tap(await target('[role="dialog"] form button[type="submit"]:last-of-type'));
    await sleep(5000);
    intercept = null;
    await S("Fetch.disable");
    const told = (await evaluate(`document.querySelector('[data-error-boundary]')?.textContent ?? ""`)) ?? "";
    check(/connection dropped/i.test(told), "a lost answer says the connection dropped", told.slice(0, 60) || "no error screen");
    check(((await rows()) ?? []).length === 1, "the first attempt reached the server");
    // The person reloads and sends the same entry again.
    let retryPosts = 0;
    if (await openDelivery()) {
      await fill();
      const before = requests.length;
      await tap(await target('[role="dialog"] form button[type="submit"]:last-of-type'));
      await sleep(6000);
      retryPosts = requests.slice(before).filter((r) => r.method === "POST" && r.action).length;
    }
    check(retryPosts === 1, "the retry was sent", `${retryPosts} post(s)`);
    const saved = (await rows()) ?? [];
    check(saved.length === 1, "the retry after a reload is not saved a second time", `${saved.length} row(s)`);
    // The success flash clears ?saved= from the address bar once shown, so read the flash.
    const landed = (await evaluate(`[...document.querySelectorAll('main [role="status"]')].map((n) => n.textContent).join(" | ")`)) ?? "";
    check(/saved/i.test(landed), "the retry lands where the first save would have (Saved)", landed.slice(0, 60) || "no message");
    for (const id of saved) {
      await fetch(`${SUPABASE_URL}/rest/v1/fuel_deliveries?id=eq.${id}`, {
        method: "DELETE",
        headers: { apikey: ANON, authorization: `Bearer ${session.access_token}` },
      }).catch(() => {});
    }
    const left = (await rows()) ?? [];
    console.log(left.length ? `NOTE  ${left.length} test delivery left on the click-through farm (${marker})` : "NOTE  test delivery removed");
  }
}

console.log(failures ? `${failures} check(s) failed` : "every check passed");
cleanup();
process.exit(failures ? 1 : 0);
