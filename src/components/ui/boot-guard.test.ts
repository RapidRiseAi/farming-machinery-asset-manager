/**
 * Buttons load until they work: the rules that decide when a tap is held.
 *
 * scripts/ready_check.mjs proves the whole thing in a throttled browser. These pin the
 * parts whose regressions would otherwise surface only as "the buttons pulse forever",
 * "taps vanish again" or "the farm switcher stopped switching": the selector list the CSS
 * and the guard must share, what the guard holds and what it lets through, its own
 * fail-safe, and the test for a control React has attached to.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  BOOT_ATTRIBUTE,
  BOOT_CONTROLS,
  BOOT_CONTROL_SELECTORS,
  BOOT_FAILSAFE_ABSOLUTE_MS,
  BOOT_FAILSAFE_AFTER_LOAD_MS,
  BOOT_GUARD,
  BOOT_OWNED_FLAG,
  BOOT_SNAPSHOT_KEY,
  allControlsHydrated,
  isHydrated,
} from "./boot-guard";

type FakeEvent = {
  target: unknown;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
};
type Listener = (event: FakeEvent) => void;

/** Runs the real guard script against a stand-in window and document that record what it does. */
function boot() {
  const attributes = new Set<string>();
  const documentListeners = new Map<string, Listener[]>();
  const windowListeners = new Map<string, Listener[]>();
  const timers: { ms: number; run: () => void }[] = [];
  const parsedControls = ["first", "second"];
  const fakeDocument = {
    documentElement: {
      setAttribute: (name: string) => void attributes.add(name),
      hasAttribute: (name: string) => attributes.has(name),
      removeAttribute: (name: string) => void attributes.delete(name),
    },
    querySelectorAll: (selector: string) => (assert.equal(selector, BOOT_CONTROLS), parsedControls),
    addEventListener: (type: string, listener: Listener, capture?: boolean) => {
      if (type === "click" || type === "submit") {
        assert.equal(capture, true, `the ${type} listener must run in the capture phase, ahead of React`);
      }
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
  };
  const fakeWindow: Record<string, unknown> = {
    addEventListener: (type: string, listener: Listener) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]),
  };
  const fakeSetTimeout = (run: () => void, ms: number) => void timers.push({ run, ms });
  new Function("window", "document", "setTimeout", BOOT_GUARD)(fakeWindow, fakeDocument, fakeSetTimeout);

  const fire = (type: string, target: unknown) => {
    const event: FakeEvent = {
      target,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
    };
    for (const listener of documentListeners.get(type) ?? []) listener(event);
    return { held: event.prevented && event.stopped, untouched: !event.prevented && !event.stopped };
  };
  /** A tap target whose nearest control is `control`, remembering the selector it was asked. */
  const tapOn = (control: object | null) => {
    const asked: string[] = [];
    return { target: { closest: (selector: string) => (asked.push(selector), control) }, asked };
  };
  const emit = (listeners: Map<string, Listener[]>, type: string) =>
    (listeners.get(type) ?? []).forEach((listener) => listener({} as FakeEvent));
  const runTimers = (ms: number) => timers.filter((timer) => timer.ms === ms).forEach((timer) => timer.run());

  return {
    attributes,
    fire,
    tapOn,
    fakeWindow,
    parsedControls,
    timers,
    runTimers,
    parsed: () => emit(documentListeners, "DOMContentLoaded"),
    loaded: () => emit(windowListeners, "load"),
    ready: () => attributes.delete(BOOT_ATTRIBUTE),
  };
}

const attached = (more: object = {}) => ({ "__reactProps$k3j2": {}, ...more });
const button = { tagName: "BUTTON", hasAttribute: () => false };
const link = { tagName: "A", hasAttribute: (name: string) => name === "href" };
const optedInLink = { tagName: "A", hasAttribute: (name: string) => name === "href" || name === "data-needs-js" };
const form = (method: string | null, more: object = {}) => ({ getAttribute: (name: string) => (name === "method" ? method : null), ...more });

test("globals.css draws the starting look for exactly the controls the guard holds", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  const pattern = new RegExp(`html\\[${BOOT_ATTRIBUTE}\\]\\s*:is\\(([^)]*)\\)`, "g");
  const lists = [...css.matchAll(pattern)].map((match) => match[1].split(",").map((part) => part.trim()));
  assert.equal(lists.length, 2, "one rule for the pulse and one for reduced motion");
  for (const list of lists) assert.deepEqual(list, [...BOOT_CONTROL_SELECTORS]);
});

test("native controls that work before hydration are not held: links, details, select", () => {
  for (const native of ["summary", "select", "a"]) {
    assert.ok(!BOOT_CONTROL_SELECTORS.some((selector) => selector === native || selector.startsWith(`${native}[`)), native);
  }
});

test("the page is marked as starting the moment the script runs", () => {
  assert.ok(boot().attributes.has(BOOT_ATTRIBUTE));
});

test("while starting, a tap on a control not yet attached is held, found with the shared selector", () => {
  const { fire, tapOn } = boot();
  const tap = tapOn(button);
  assert.ok(fire("click", tap.target).held);
  assert.deepEqual(tap.asked, [BOOT_CONTROLS]);
});

test("while starting, a control React has already attached works at once", () => {
  const { fire, tapOn } = boot();
  assert.ok(fire("click", tapOn(attached(button)).target).untouched);
});

test("while starting, plain links still work, and an opted-in link waits", () => {
  const { fire, tapOn } = boot();
  assert.ok(fire("click", tapOn(link).target).untouched);
  assert.ok(fire("click", tapOn(optedInLink).target).held);
});

test("while starting, a tap outside any control is left alone", () => {
  const { fire, tapOn } = boot();
  assert.ok(fire("click", tapOn(null).target).untouched);
  // The document itself, or anything else without closest(), is not a control either.
  assert.ok(fire("click", {}).untouched);
  assert.ok(fire("click", null).untouched);
});

test("while starting, a form React does not own yet cannot submit natively", () => {
  const { fire } = boot();
  assert.ok(fire("submit", form(null)).held, "a client form would reload with its values in the URL");
  assert.ok(fire("submit", form("post")).held, "a server-action form would skip the client's confirmation");
});

test("while starting, a form React owns submits (the farm switcher), and so does a GET form", () => {
  const { fire } = boot();
  assert.ok(fire("submit", attached(form(null))).untouched);
  assert.ok(fire("submit", form("get")).untouched, "SearchField and the filter forms work natively");
  assert.ok(fire("submit", form("GET")).untouched);
});

test("once the page works, the guard steps aside completely", () => {
  const { fire, tapOn, ready } = boot();
  ready();
  assert.ok(fire("click", tapOn(button).target).untouched);
  assert.ok(fire("submit", form(null)).untouched);
});

test("the controls in the server's HTML are recorded once it is parsed", () => {
  const { fakeWindow, parsed, parsedControls } = boot();
  assert.equal(fakeWindow[BOOT_SNAPSHOT_KEY], undefined);
  parsed();
  assert.equal(fakeWindow[BOOT_SNAPSHOT_KEY], parsedControls);
});

test("if React never starts, the guard lets go by itself after load, and by an absolute limit", () => {
  const afterLoad = boot();
  afterLoad.loaded();
  afterLoad.runTimers(BOOT_FAILSAFE_AFTER_LOAD_MS);
  assert.ok(!afterLoad.attributes.has(BOOT_ATTRIBUTE));

  const neverLoaded = boot();
  neverLoaded.runTimers(BOOT_FAILSAFE_ABSOLUTE_MS);
  assert.ok(!neverLoaded.attributes.has(BOOT_ATTRIBUTE));
});

test("once BootReady has taken over, the guard's fail-safe stands down", () => {
  const owned = boot();
  owned.fakeWindow[BOOT_OWNED_FLAG] = true;
  owned.loaded();
  owned.runTimers(BOOT_FAILSAFE_AFTER_LOAD_MS);
  owned.runTimers(BOOT_FAILSAFE_ABSOLUTE_MS);
  assert.ok(owned.attributes.has(BOOT_ATTRIBUTE), "BootReady decides, with its active-time caps");
});

test("the guard script cannot break the page it is inlined into", () => {
  assert.ok(!BOOT_GUARD.includes("</script"), "would end the inline <script> early");
  assert.ok(!BOOT_GUARD.includes("`"));
  assert.doesNotThrow(() => new Function(BOOT_GUARD));
  const hostile = {
    documentElement: { setAttribute() {}, hasAttribute: () => true },
    addEventListener() {
      throw new Error("blocked");
    },
  };
  assert.doesNotThrow(() => new Function("window", "document", "setTimeout", BOOT_GUARD)({}, hostile, () => {}));
});

test("a control counts as working only once React has attached its props", () => {
  assert.equal(isHydrated({ "__reactProps$k3j2": {} }), true);
  assert.equal(isHydrated({ "__reactFiber$k3j2": {} }), false, "a fiber alone carries no handlers");
  assert.equal(isHydrated({}), false);
});

test("the page is ready only when every control is attached; an empty page is ready", () => {
  assert.equal(allControlsHydrated([]), true);
  assert.equal(allControlsHydrated([attached(), attached()]), true);
  assert.equal(allControlsHydrated([attached(), {}]), false);
});
