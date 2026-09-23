#!/usr/bin/env node
/**
 * Does the interface actually work in a browser?
 *
 * == The gap this closes =====================================================
 * CLAUDE.md already records that three test layers all miss reachability: the TS tests
 * mock the Supabase client so they assert arguments, `db:test` does not call the
 * database the way the app does, and the build only compiles a string.
 * `click_through.mjs` closed part of it by fetching real HTML as a signed-in owner.
 *
 * None of them can see a dialog. A dialog is client state, so a harness that reads HTML
 * sees the trigger and never what the trigger does, and every capture form in this
 * product now lives behind one. Two defects found while writing this file were
 * invisible to every other gate:
 *
 *   · `Overlay` leaked its scroll lock when a server action's redirect unmounted two
 *     overlapping overlays, leaving `document.body` at `overflow: hidden` so the page
 *     could not be scrolled again until a reload. Only reproducible by opening a row
 *     menu, opening a dialog inside it, and submitting.
 *   · `/settings` saves one group at a time, and the action rebuilt the whole settings
 *     blob from the submitted form. Proving that saving quiet hours does not reset the
 *     farm's VAT rate needs the values read back off the rendered page.
 *
 * == What it asserts =========================================================
 * Per route: it renders for a signed-in owner, it is not a wall of input boxes, no raw
 * i18n key reaches the screen, nothing is open before it is asked for, and every
 * dialog trigger opens a labelled modal that Escape closes and that gives the page its
 * scroll back. It does not assert layout or colour; `design_lint` owns those.
 *
 *   node scripts/ui_check.mjs                  # against http://localhost:3111
 *   node scripts/ui_check.mjs --base=http://localhost:3000
 *   node scripts/ui_check.mjs --route=/tyres   # one route
 *   node scripts/ui_check.mjs --require        # fail, rather than skip, with no Chrome
 *
 * Needs the app running (`npx next start -p 3111`) and a `.env.local`, exactly as
 * `click_through.mjs` does. Skips cleanly when there is no Chrome, so it can sit in a
 * pipeline that has no browser without turning it red.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const ROOT = process.cwd();
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const BASE = arg("base") ?? "http://localhost:3111";
const ONLY = arg("route");
const REQUIRE = process.argv.includes("--require");
const PORT = Number(arg("port") ?? 9455);

/**
 * Routes whose capture forms moved into dialogs, with how many form controls may
 * remain ON the page. A settings page legitimately keeps a tone switcher; a fault
 * list keeps nothing.
 *
 * The ceiling is the point of the check. It is what stops a page quietly growing a
 * new always-open form: add one and this fails with a count, not an opinion.
 */
/**
 * The click-through farm's seeded rows. A detail route needs a real row;
 * `scripts/seed_test_farm.mjs` creates these and `--remove` deletes exactly them.
 */
const TEST_MACHINE = "f0000000-0000-4000-8000-00000000aa01";
const TEST_JOBCARD = "f0000000-0000-4000-8000-00000000bc01";

const ROUTES = [
  { path: "/tyres", maxControls: 0, minTriggers: 1 },
  { path: "/incidents", maxControls: 0, minTriggers: 1 },
  // The tone switcher is buttons, not inputs, so this measures 0. The 2 is headroom,
  // not an allowance for a form.
  { path: "/settings", maxControls: 2, minTriggers: 8 },
  { path: "/faults", maxControls: 0, minTriggers: 1 },
  { path: "/fuel", maxControls: 2, minTriggers: 1 },
  /*
   * `/fines` is the one screen that keeps a capture form on the page, deliberately.
   * Its capture is a two-step flow: a GET form picks the vehicle and the offence date,
   * the server looks that up in the usage log, and only then does the ten-field form
   * render, with the driver already suggested. Moving step one into a dialog would
   * break it, because submitting a GET navigates and would close the dialog it was
   * submitted from. Step one is two controls, which is what this ceiling is.
   *
   * `minTriggers: 0` because every dialog on this page belongs to a ROW, and the
   * `fines` table is empty on the click-through farm (verified: 0 rows). Demanding a
   * trigger here would assert something about the fixture rather than about the page.
   */
  { path: "/fines", maxControls: 2, minTriggers: 0 },
  // The catalogue search box stays on the page: it is how you use a few hundred parts.
  { path: "/parts", maxControls: 2, minTriggers: 1 },
  { path: "/team", maxControls: 2, minTriggers: 1 },
  { path: "/team/licences", maxControls: 2, minTriggers: 1 },
  { path: "/partners", maxControls: 2, minTriggers: 1 },
  /*
   * == Converted screens this gate CANNOT reach, and why =======================
   * Not an oversight, and worth stating so nobody assumes they were forgotten. This
   * gate signs in as the click-through OWNER, the only throwaway credential that
   * exists, so anything gated to another role can only ever be measured as a redirect:
   *
   *   · `/suppliers`, `/contractor/settings`, `/contractor/clients/[id]`,
   *     `/recurring/[id]` are workshop-only. Suppliers in particular must stay that
   *     way: a farm reading its contractor's supplier terms would be reading the margin
   *     behind every quote it is given.
   *   · `/admin/farms/[id]` is rr_admin only.
   *   · `/documents/[id]` needs a document row, and the click-through farm has none
   *     (verified: zero `partner_documents` for it).
   *
   * Covering them needs a throwaway workshop and an rr_admin, which `click_through.mjs`
   * does not have either. Until then those six are covered by typecheck, lint, build and
   * the unit tests around the actions they post to, and not by a browser.
   */
  /*
   * The machine file. It held fourteen `<details>` blocks in three different styles,
   * several of them rendering a full edit form for EVERY row of a list, with bare
   * `<input placeholder=...>` fields that had no label at all. It is the densest screen
   * in the product and therefore the one most worth a ceiling.
   *
   * The id is the click-through farm's tractor. A detail route needs a real row, so
   * this is the seeded one; `scripts/seed_test_farm.mjs` creates it and `--remove`
   * deletes it.
   *
   * Two numbers here are deliberately loose, and both were measured rather than chosen:
   *
   *   · `maxControls: 4` because the Overview tab keeps the "log a meter reading" form
   *     (reading, date, driver) plus a photo input. Logging hours is the one thing an
   *     operator opens this screen to DO, daily, and putting the daily task behind a
   *     button to save four controls would be the tail wagging the dog.
   *   · `minTriggers: 2` because the page is five `Tabs` and only the active panel is
   *     rendered, so the eleven dialogs on Servicing, Costs and Papers are not in the
   *     DOM until their tab is chosen. Two is what Overview actually carries.
   */
  { path: `/machines/${TEST_MACHINE}`, maxControls: 4, minTriggers: 2 },
];

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
  const note = "ui_check: no Chrome found, skipping the browser checks.";
  if (REQUIRE) {
    console.error(note.replace("skipping", "REQUIRED but cannot run"));
    process.exit(1);
  }
  console.log(note);
  process.exit(0);
}

function readEnv(name) {
  const text = readFileSync(join(ROOT, ".env.local"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// == Sign in the way the app does, and build the cookie @supabase/ssr writes ==
const SUPABASE_URL = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON = readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "clickthrough@fleetwise.test", password: "Clickthrough!2026" }),
});
if (!res.ok) {
  console.error(`ui_check: could not sign in: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const session = await res.json();
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const encoded =
  "base64-" +
  Buffer.from(
    JSON.stringify({
      access_token: session.access_token,
      token_type: "bearer",
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      refresh_token: session.refresh_token,
      user: session.user,
    }),
    "utf8",
  ).toString("base64");
const CHUNK = 3180;
const cookies = [];
if (encoded.length <= CHUNK) cookies.push([`sb-${ref}-auth-token`, encoded]);
else
  for (let i = 0, n = 0; i < encoded.length; i += CHUNK, n += 1)
    cookies.push([`sb-${ref}-auth-token.${n}`, encoded.slice(i, i + CHUNK)]);

// == Chrome over CDP, no dependency (node 22+ has a global WebSocket) ========
const profileDir = mkdtempSync(join(os.tmpdir(), "fw-ui-check-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1200,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup() {
  try { chrome.kill(); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
process.on("exit", cleanup);

async function debuggerUrl() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Chrome never opened a debugging port");
}

/**
 * EVERY route a signed-in owner can reach fits a 360px phone.
 *
 * Wider than the dialog list, because this failure has nothing to do with dialogs and
 * everything to do with the device the product is used on.
 *
 * This list was 28 routes against 82 `page.tsx` files, chosen by hand, and the 54 it
 * left out were not "covered elsewhere", they were unmeasured. Sweeping the rest found
 * `/machines/[id]`, one of the most-used screens in the product, forcing a 415px
 * layout on a 360px phone: the tab strip's five tabs come to 415px at their natural
 * width, and when content cannot fit Chrome widens the layout viewport instead of
 * scrolling, so the whole page renders zoomed out with nothing to notice.
 *
 * So the rule is now the inventory, not a selection from it. A new screen is added
 * here, and what stays out is only what this credential genuinely cannot open:
 * workshop-only (`/contractor/*`), rr_admin-only (`/admin/*`), operator-only
 * (`/driver`), the signed-out and marketing pages, and the token routes
 * (`/m/[token]`, `/d/[token]`, `/verify/[token]`) which need a token to mean anything.
 */
const MOBILE_ROUTES = [
  "/dashboard", "/machines", "/machines/new", "/machines/import",
  `/machines/${TEST_MACHINE}`, `/machines/${TEST_MACHINE}/qr`,
  `/machines/${TEST_MACHINE}/checklists/new`,
  "/jobcards", `/jobcards/${TEST_JOBCARD}`, "/faults", "/tyres", "/incidents",
  "/settings", "/settings/api", "/fuel", "/fines", "/parts", "/team",
  "/team/licences", "/partners", "/suppliers", "/money", "/orders",
  "/expenses", "/recurring-expenses", "/recurring", "/vat", "/accounting",
  "/statements", "/banking", "/banking/import", "/cashflow", "/reports",
  "/reports/assets", "/reports/schedules", "/calendar", "/checklists",
  "/checklists/new", "/documents", "/documents/corrections", "/work",
  "/account", "/notifications", "/help", "/inbox", "/billing", "/install",
  "/assistant", "/onboarding", "/queue", "/closed", "/home", "/offline",
];

const ws = new WebSocket(await debuggerUrl());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const waiters = new Map();
let logEntries = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiters.has(msg.id)) {
    const { resolve, reject } = waiters.get(msg.id);
    waiters.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === "Log.entryAdded" || msg.method === "Runtime.exceptionThrown") {
    logEntries.push(msg);
  }
};
const rpc = (method, params = {}, sessionId) => {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
};

const { targetInfos } = await rpc("Target.getTargets");
const target = targetInfos.find((t) => t.type === "page");
const { sessionId } = await rpc("Target.attachToTarget", { targetId: target.targetId, flatten: true });
const S = (method, params) => rpc(method, params, sessionId);

await S("Page.enable");
await S("Runtime.enable");
await S("Log.enable");
await S("Network.enable");

/*
 * Bypass the service worker.
 *
 * This gate hard-navigates to every route in one tab, and after about eight such loads
 * with `sw.js` in control, pages STOP HYDRATING: the markup is correct, the buttons are
 * visible and enabled, React has attached nothing, and clicking does exactly nothing.
 * No console error, no error boundary. It cost a long detour to find, so here is how it
 * was pinned down, to save the next person the same walk:
 *
 *   · `/machines/[id]` failed as the 9th route and passed when run alone.
 *   · 8 loads of `/team` then `/machines/[id]` reproduced it, so it was cumulative
 *     rather than route-specific.
 *   · `/machines/import`, `/statements` and `/settings/api`, none of them touched, and
 *     `/tyres` at a third of the bundle size, ALL failed the same way, so it was
 *     neither a regression nor bundle weight.
 *   · With `Network.setBypassServiceWorker`, the 9th and 10th loads hydrate fine.
 *
 * So the cache layer is what breaks, and this gate is about the INTERFACE. Bypassing it
 * measures the app. Whether the same thing can be provoked on a real device by a real
 * person is a separate question, recorded in the build log rather than answered here.
 */
await S("Network.setBypassServiceWorker", { bypass: true });

for (const [name, value] of cookies)
  await S("Network.setCookie", { name, value, domain: "localhost", path: "/" });

async function evaluate(expression) {
  const r = await S("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error("page threw: " + (d.exception?.description ?? JSON.stringify(d)));
  }
  return r.result.value;
}

async function goto(url) {
  logEntries = [];
  await S("Page.navigate", { url });
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    if (await evaluate("document.readyState === 'complete'").catch(() => false)) break;
  }
  // Hydration, not load: every assertion below is about client behaviour.
  await new Promise((r) => setTimeout(r, 1100));
}

const pressEscape = async () => {
  // A real key event, not `new KeyboardEvent(...)`. A synthetic one reaches React's
  // handler and closes the dialog but never moves focus, so the focus-restore assertion
  // failed against a component that restores focus correctly.
  await S("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await S("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
};

const consoleErrors = () =>
  logEntries
    .filter(
      (e) =>
        (e.method === "Log.entryAdded" && e.params.entry.level === "error") ||
        e.method === "Runtime.exceptionThrown",
    )
    .map((e) =>
      e.method === "Log.entryAdded"
        ? e.params.entry.text
        : (e.params.exceptionDetails?.exception?.description ?? "exception"),
    )
    // A signed-in page legitimately fetches things that can 404 (a missing signed URL
    // for an attachment, say). Only script-level failures are this gate's business.
    .filter((t) => !/favicon|manifest|Failed to load resource/i.test(t));

// == The walk ================================================================
const problems = [];
const fail = (route, msg) => problems.push(`${route}: ${msg}`);
const routes = ONLY ? ROUTES.filter((r) => r.path === ONLY) : ROUTES;
if (ONLY && routes.length === 0) {
  console.error(`ui_check: --route=${ONLY} is not one of the checked routes`);
  process.exit(1);
}

console.log(`ui_check: ${routes.length} routes against ${BASE}\n`);

for (const route of routes) {
  await goto(BASE + route.path);

  const view = await evaluate(`(() => {
    /*
      Scope everything to <main>, and to what is actually VISIBLE.

      Both of those were bugs in this file. The app shell renders a mobile "More" nav
      button that carries aria-haspopup="dialog", so on a 1200px-wide window this gate
      picked a display:none button as "the page's first dialog trigger", opened its
      sheet, and then reported "focus was not restored" on four pages, because
      .focus() on a hidden element does nothing and there was never anything to
      restore to. The page's own chrome is not what this gate is measuring.
    */
    const main = document.querySelector('main') ?? document.body;
    const seen = (el) => el.offsetParent !== null;
    const body = main.innerText ?? '';
    return {
      h1: document.querySelector('h1')?.textContent?.trim() ?? '',
      controls: [...main.querySelectorAll('input:not([type=hidden]), select, textarea')]
        .filter(seen).length,
      dialogs: document.querySelectorAll('[role=dialog]').length,
      triggers: [...main.querySelectorAll('button[aria-haspopup=dialog]')].filter(seen).length,
      // A raw key looks like "tyres.fieldBrand": dotted, no spaces, lowerCamel segments.
      // Emails and hostnames match that shape too, so they are excluded explicitly:
      // the click-through owner is clickthrough@fleetwise.test, and "fleetwise.test"
      // was reported as an untranslated key on /settings and /team.
      rawKeys: (body.match(/(?:^|[^@\\w.])([a-z][a-zA-Z0-9]*(?:\\.[a-z][a-zA-Z0-9]*){1,3})(?![\\w.])/g) ?? [])
        .map((s) => s.replace(/^[^a-z]+/, ''))
        .filter((s) => !/\\.(com|co|za|org|net|test|local|json|tsx?|mjs|pdf|png|jpg)$/i.test(s))
        .slice(0, 5),
      signedOut: /sign in|meld aan/i.test(document.title ?? ''),
      // The error boundary has an <h1> of its own, so "there is an h1" is not proof the
      // page rendered. A crashed /machines/[id] was reported as healthy-with-no-dialogs
      // until this marker existed.
      crashed: !!document.querySelector('[data-error-boundary]'),
    };
  })()`);

  if (view.crashed)
    fail(route.path, "fell into its error boundary (check the server log for the throw)");
  if (!view.h1) fail(route.path, "rendered no <h1> (redirected, or 500)");
  if (view.signedOut) fail(route.path, "bounced to a sign-in page");
  if (view.dialogs > 0) fail(route.path, `${view.dialogs} dialog(s) already open before anything was pressed`);
  if (view.controls > route.maxControls)
    fail(
      route.path,
      `${view.controls} form controls on the page at rest, ceiling is ${route.maxControls}. ` +
        `A capture form has been left open on the page instead of behind a dialog.`,
    );
  if (view.triggers < route.minTriggers)
    fail(route.path, `${view.triggers} dialog trigger(s), expected at least ${route.minTriggers}`);
  if (view.rawKeys.length)
    fail(route.path, `raw i18n key(s) on screen: ${view.rawKeys.join(", ")}`);

  // The first trigger must actually open a labelled modal, and give the page back.
  let dialog = null;
  if (view.triggers > 0) {
    /*
     * Click, then poll, then click AGAIN if nothing opened.
     *
     * The re-click is the part that matters. A click that lands before React has
     * hydrated hits a button with no handler attached yet: nothing happens, and no
     * amount of waiting afterwards helps, because the event is already gone. This
     * reported "the first dialog trigger opened nothing" on `/machines/[id]`, whose
     * first-load JS is 351 kB, while the same click by hand always worked. Waiting for
     * `readyState === "complete"` does not mean hydrated.
     */
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await evaluate(`(() => {
        const main = document.querySelector('main') ?? document.body;
        const b = [...main.querySelectorAll('button[aria-haspopup=dialog]')]
          .find((el) => el.offsetParent !== null);
        if (!b) return;
        // A real pointer click focuses before activating; .click() alone does not, and
        // then there is nothing for the dialog to restore focus to on close.
        b.focus();
        b.click();
      })()`);
      let opened = false;
      for (let i = 0; i < 8; i += 1) {
        if (await evaluate("document.querySelectorAll('[role=dialog]').length > 0")) {
          opened = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (opened) break;
    }
    dialog = await evaluate(`(() => {
      const d = document.querySelector('[role=dialog]');
      if (!d) return null;
      const labelId = d.getAttribute('aria-labelledby');
      return {
        modal: d.getAttribute('aria-modal') === 'true',
        named: !!(labelId && document.getElementById(labelId)?.textContent?.trim()),
        closes: [...d.querySelectorAll('button')].length > 0,
        locked: document.body.style.overflow === 'hidden',
        focusInside: d.contains(document.activeElement),
      };
    })()`);
    if (!dialog) fail(route.path, "the first dialog trigger opened nothing");
    else {
      if (!dialog.modal) fail(route.path, "dialog is missing aria-modal");
      if (!dialog.named) fail(route.path, "dialog has no resolvable accessible name");
      if (!dialog.locked) fail(route.path, "dialog did not lock body scroll");
      if (!dialog.focusInside) fail(route.path, "dialog did not move focus into itself");

      await pressEscape();
      await new Promise((r) => setTimeout(r, 500));
      const after = await evaluate(`({
        gone: document.querySelectorAll('[role=dialog]').length === 0,
        unlocked: document.body.style.overflow !== 'hidden',
        onTrigger: document.activeElement?.getAttribute('aria-haspopup') === 'dialog',
      })`);
      if (!after.gone) fail(route.path, "Escape did not close the dialog");
      // The one that shipped broken: two overlapping overlays used to leave the page
      // permanently unscrollable.
      if (!after.unlocked) fail(route.path, "body scroll was still locked after the dialog closed");
      if (!after.onTrigger) fail(route.path, "focus was not restored to the trigger");
    }
  }

  const errs = consoleErrors();
  if (errs.length) fail(route.path, `console error(s): ${errs.slice(0, 2).join(" | ").slice(0, 200)}`);

  const mark = problems.some((p) => p.startsWith(route.path + ":")) ? "FAIL" : "ok  ";
  console.log(
    `  ${mark}  ${route.path.padEnd(12)} ` +
      `controls=${String(view.controls).padStart(2)}/${route.maxControls}  ` +
      `triggers=${String(view.triggers).padStart(2)}  ` +
      `dialog=${dialog ? "opens, closes, restores" : "n/a"}`,
  );
}

/*
 * == Does it fit a phone? ====================================================
 *
 * `Emulation.setDeviceMetricsOverride`, not `--window-size`: CLAUDE.md records that
 * Windows will not lay a WINDOW out narrower than ~500px, so a window-based "360px"
 * measurement is really 504. Device metrics are a different mechanism, and the check
 * below asserts the frame's own `innerWidth` so the measurement proves its own width
 * rather than claiming it.
 *
 * Two different failures, and the second is the one that hid for months:
 *
 *   · `scrollWidth > innerWidth` is ordinary horizontal overflow, a sideways scrollbar.
 *   · `innerWidth > 360` is WORSE and silent. When something cannot fit, Chrome widens
 *     the layout viewport to the content's minimum instead of overflowing, and the whole
 *     page renders zoomed out. Nothing scrolls sideways, so nothing looks wrong, and the
 *     text is simply smaller than it should be. `/reports/assets` sat at 442px because
 *     three whole-fleet money tiles shared a hard `grid-cols-3`: `rands` joins thousands
 *     with U+00A0, so "R1 500 000,00" is one unbreakable ~200px token at `text-3xl`.
 */
console.log("");
console.log(`  fits a 360px phone? (${MOBILE_ROUTES.length} routes)`);
await S("Emulation.setDeviceMetricsOverride", {
  width: 360,
  height: 780,
  deviceScaleFactor: 2,
  mobile: true,
});

let narrowChecked = 0;
for (const path of MOBILE_ROUTES) {
  await goto(BASE + path);
  const m = await evaluate(`(() => {
    const d = document.documentElement;
    const main = document.querySelector('main') ?? document.body;
    let worst = null;
    for (const el of main.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > window.innerWidth + 1 && (!worst || r.right > worst.right)) {
        worst = { right: Math.round(r.right), tag: el.tagName, cls: (el.className || '').toString().slice(0, 50) };
      }
    }
    return {
      innerWidth: window.innerWidth,
      scrollWidth: d.scrollWidth,
      crashed: !!document.querySelector('[data-error-boundary]'),
      worst,
    };
  })()`);

  if (m.crashed) {
    fail(path, "fell into its error boundary at 360px");
    continue;
  }
  narrowChecked += 1;
  const zoomedOut = m.innerWidth > 361;
  const overflows = m.scrollWidth > m.innerWidth + 1;
  if (zoomedOut)
    fail(
      path,
      `forces a ${m.innerWidth}px layout on a 360px phone, so the whole page renders ` +
        `zoomed out${m.worst ? ` (widest: ${m.worst.tag}.${m.worst.cls})` : ""}`,
    );
  else if (overflows)
    fail(
      path,
      `scrolls sideways at 360px (content ${m.scrollWidth}px)` +
        `${m.worst ? ` (widest: ${m.worst.tag}.${m.worst.cls})` : ""}`,
    );
}
console.log(
  `  ${problems.some((p) => MOBILE_ROUTES.some((r) => p.startsWith(r + ":"))) ? "FAIL" : "ok  "}` +
    `  ${narrowChecked} route(s) measured at 360px`,
);

/*
 * == And a small laptop ======================================================
 *
 * 1024px is the narrowest width at which `lg:` applies, so it is where a layout that
 * only ever ran at 1280 first shows its seams. A stacked table is a column of cards
 * below `lg` and a real table from `lg` up, and the first version of that shipped
 * WITHOUT the horizontal scroll wrapper on the grounds that cards cannot overflow:
 * true on a phone, wrong the moment the columns come back. Measured here, `/team` laid
 * out an 823px table inside a 687px column and pushed the document to 1112px, so the
 * whole page scrolled sideways on a 13-inch laptop.
 *
 * The assertion is only about the PAGE. A table that scrolls inside its own wrapper is
 * the intended design and has been since the kit was written.
 */
console.log("");
console.log(`  no sideways scroll on a 1024px laptop? (${MOBILE_ROUTES.length} routes)`);
await S("Emulation.setDeviceMetricsOverride", {
  width: 1024,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
let wideChecked = 0;
const wideProblems = [];
for (const path of MOBILE_ROUTES) {
  await goto(BASE + path);
  const m = await evaluate(`(() => {
    const d = document.documentElement;
    return {
      innerWidth: window.innerWidth,
      scrollWidth: d.scrollWidth,
      crashed: !!document.querySelector('[data-error-boundary]'),
    };
  })()`);
  if (m.crashed) continue;
  wideChecked += 1;
  if (m.scrollWidth > m.innerWidth + 1) {
    wideProblems.push(path);
    fail(path, `the page scrolls sideways at 1024px (content ${m.scrollWidth}px)`);
  }
}
console.log(`  ${wideProblems.length ? "FAIL" : "ok  "}  ${wideChecked} route(s) measured at 1024px`);

console.log("");
if (problems.length) {
  console.log("==========================================================");
  for (const p of problems) console.log(`  ${p}`);
  console.log("==========================================================");
  console.log(`  ${problems.length} problem(s).`);
  ws.close();
  process.exit(1);
}
console.log("==========================================================");
console.log("  Every checked screen opens its forms in a dialog, gives the page back,");
console.log("  and fits a 360px phone.");
ws.close();
process.exit(0);
