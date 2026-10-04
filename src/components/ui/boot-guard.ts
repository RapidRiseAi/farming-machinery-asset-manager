/**
 * Buttons load until they work.
 *
 * The server sends every page with its buttons already drawn, and React attaches to them
 * only once the page's JavaScript has run. On the live site that took up to about 4 s on
 * a desktop connection, and longer on a phone out on the farm; a tap in that gap did
 * nothing at all and was simply lost. So the page is marked as starting before it is
 * painted, every control that needs JavaScript pulses and ignores taps while it is, and
 * the mark comes off once the controls actually work.
 *
 * Three parts share the names in this file:
 *   · BOOT_GUARD, an inline script at the top of the root layout's <head>: sets the mark
 *     before first paint and holds clicks and form submits on controls while it is set;
 *   · globals.css, which draws the starting look for the same selector list;
 *   · <BootReady/> (boot-ready.tsx), which takes the mark off after hydration.
 *
 * The mark is public: a browser check waits for it to clear before it taps anything
 * (scripts/ready_check.mjs, ui_check.mjs, voice_check.mjs).
 */

/** The attribute on <html> while the page is starting. */
export const BOOT_ATTRIBUTE = "data-booting";

/**
 * Every control that needs JavaScript to do anything. Left out on purpose, because they
 * work natively before hydration: links (<a href>), native <details>/<summary> (every
 * Disclosure), and <select> (the browser opens and changes it).
 *
 * `data-needs-js` is the opt-in for anything native whose real behaviour is JavaScript: a
 * select that acts in its onChange (the farm switcher), or a link whose onClick must run
 * (FilterBar's Clear, which forgets remembered filters). It is held and drawn as starting
 * like a button, links included.
 *
 * globals.css repeats this list, because CSS cannot import it; a test keeps the two equal.
 */
export const BOOT_CONTROL_SELECTORS = [
  "button",
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="submit"]',
  'input[type="button"]',
  'input[type="reset"]',
  "[data-needs-js]",
] as const;

export const BOOT_CONTROLS = BOOT_CONTROL_SELECTORS.join(",");

/**
 * Once the document has finished arriving, how long to keep waiting for its controls to
 * attach before giving the page back anyway. Content inside a Suspense boundary (every
 * route with a loading.tsx, and anything streamed late) hydrates after the root, so the
 * root committing does not yet mean the page's own buttons work. This cap means the page
 * can never stay held back: if React ever renamed the internal checked below, or a
 * browser extension put in a button React will never own, the cost is at most this long,
 * once per page load.
 */
export const BOOT_SETTLE_CAP_MS = 4000;

/**
 * The longest the page is ever held after React has started, even if the document is
 * still streaming: a response that never closes must not hold the page forever. Both
 * caps count only time the page was actually running, not time frozen in the background.
 */
export const BOOT_HARD_CAP_MS = 12_000;

/**
 * The guard's own way out, for when React never starts at all: a framework chunk lost on
 * rural mobile data, a page the service worker served offline without its scripts, a
 * browser that cannot run the bundle. Without it the page would stay held for its whole
 * life, blocking even what works with no JavaScript (server-action forms, GET search
 * forms). Unless <BootReady/> has taken over, the mark comes off this long after the
 * window's load event, or after the absolute limit if load never fires.
 */
export const BOOT_FAILSAFE_AFTER_LOAD_MS = 15_000;
export const BOOT_FAILSAFE_ABSOLUTE_MS = 30_000;

/** Set on window by <BootReady/> when it takes over the timing from the inline guard. */
export const BOOT_OWNED_FLAG = "__fwBootOwned";

/**
 * The controls in the server's HTML, recorded by the guard once the document is parsed.
 * BootReady waits for these rather than for everything on the page, so a button a browser
 * extension injects later (which React never owns) cannot hold every page load to the cap.
 */
export const BOOT_SNAPSHOT_KEY = "__fwBootControls";

/**
 * React gives every element it has hydrated an own property named `__reactProps$<id>`;
 * its event system reads handlers from it, so a control without one cannot respond yet.
 * Internal to React, which is why every use of this is bounded by BOOT_SETTLE_CAP_MS.
 */
export function isHydrated(element: object): boolean {
  return Object.keys(element).some((key) => key.startsWith("__reactProps"));
}

/** True once every control given is attached. A page with no controls is ready. */
export function allControlsHydrated(controls: ArrayLike<object>): boolean {
  for (let index = 0; index < controls.length; index += 1) {
    if (!isHydrated(controls[index])) return false;
  }
  return true;
}

/**
 * Runs before the body is parsed, so it stays tiny, plain ES5, and cannot throw past its
 * own try. Its listeners are on `document` in the capture phase, registered before React
 * hydrates the App Router's root container (`document` itself), so while the mark is set
 * they run first.
 *
 * It holds only what cannot work yet. A tap on a control React has already attached (the
 * header and sidebar often attach seconds before the page body) goes straight through, and
 * so does a submit from a form React owns (the farm switcher's requestSubmit). What it
 * holds: a tap on a control that is not attached, which would otherwise go nowhere; and a
 * native submit of a form React does not own yet, which would reload the page with its
 * field values in the address bar (a client form) or skip a confirmation the client adds
 * (a server-action form). Links and forms with an explicit method="get" (SearchField and
 * the filter forms) are let through, because they work natively.
 */
export const BOOT_GUARD =
  "try{(function(w,d){" +
  `var r=d.documentElement,a=${JSON.stringify(BOOT_ATTRIBUTE)},c=${JSON.stringify(BOOT_CONTROLS)};` +
  "r.setAttribute(a,'');" +
  "function own(n){if(!n)return false;var k=Object.keys(n);for(var i=0;i<k.length;i++)if(k[i].indexOf('__reactProps')===0)return true;return false}" +
  "function s(e){e.preventDefault();e.stopImmediatePropagation()}" +
  "d.addEventListener('click',function(e){if(!r.hasAttribute(a))return;var t=e.target,k=t&&t.closest?t.closest(c):null;" +
  "if(!k||own(k))return;" +
  "if(k.tagName==='A'&&k.hasAttribute('href')&&!k.hasAttribute('data-needs-js'))return;s(e)},true);" +
  "d.addEventListener('submit',function(e){if(!r.hasAttribute(a))return;var f=e.target;" +
  "if(own(f)||(f&&f.getAttribute&&(f.getAttribute('method')||'').toLowerCase()==='get'))return;s(e)},true);" +
  `d.addEventListener('DOMContentLoaded',function(){w[${JSON.stringify(BOOT_SNAPSHOT_KEY)}]=d.querySelectorAll(c)});` +
  `function x(){if(!w[${JSON.stringify(BOOT_OWNED_FLAG)}])r.removeAttribute(a)}` +
  `w.addEventListener('load',function(){setTimeout(x,${BOOT_FAILSAFE_AFTER_LOAD_MS})});` +
  `setTimeout(x,${BOOT_FAILSAFE_ABSOLUTE_MS})` +
  "})(window,document)}catch(e){}";
