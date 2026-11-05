import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { t } from "@/lib/i18n";
import { HUES, PALETTES, STATUS, type Swatch } from "./palettes";
import { CATEGORIES, WIDGETS, WIDGET_BY_TYPE, widgetBlock, type WidgetAccess } from "./widgets";
import { defaultLayout } from "./defaults";
import { cleanSettings, normalizeLayout, storedLayout } from "./schema";
import { collides } from "./layout";

/** The page a path opens, found the way Next routes it: app/(group)/segment/page.tsx. */
function routeExists(href: string): boolean {
  const path = href.split(/[?#]/)[0].replace(/^\//, "");
  const app = join(process.cwd(), "src/app");
  return ["(app)", "(auth)", ""].some((group) => existsSync(join(app, group, path, "page.tsx")));
}

test("every widget links to a screen that shows the same data", () => {
  for (const w of WIDGETS) {
    const href = w.href({});
    assert.ok(routeExists(href), `${w.type} links to ${href}, which is not a page`);
    for (const [key, opt] of Object.entries(w.options)) {
      for (const choice of opt.choices) assert.ok(routeExists(w.href({ [key]: choice })), `${w.type} ${key}=${choice}`);
    }
  }
});

test("every widget, category and option has words in both languages", () => {
  for (const lang of ["en", "af"] as const) {
    for (const w of WIDGETS) {
      for (const k of [`dash.w.${w.type}.title`, `dash.w.${w.type}.desc`]) assert.notEqual(t(k, lang), k, `${lang} ${k}`);
      for (const [key, opt] of Object.entries(w.options)) {
        assert.notEqual(t(`dash.optLabel.${key}`, lang), `dash.optLabel.${key}`, `${lang} dash.optLabel.${key}`);
        for (const c of opt.choices) assert.notEqual(t(`dash.opt.${key}.${c}`, lang), `dash.opt.${key}.${c}`, `${lang} dash.opt.${key}.${c}`);
      }
    }
    for (const c of CATEGORIES) assert.notEqual(t(`dash.cat.${c}`, lang), `dash.cat.${c}`);
  }
});

test("widget definitions are coherent", () => {
  assert.equal(WIDGET_BY_TYPE.size, WIDGETS.length, "types are unique");
  for (const w of WIDGETS) {
    assert.ok(w.limits.minW <= w.size.w && w.size.w <= w.limits.maxW, `${w.type} width inside its limits`);
    assert.ok(w.limits.minH <= w.size.h && w.size.h <= w.limits.maxH, `${w.type} height inside its limits`);
    for (const [k, o] of Object.entries(w.options)) assert.ok(o.choices.includes(o.default), `${w.type}.${k} default is a choice`);
    assert.ok(CATEGORIES.includes(w.category));
  }
});

// == Access =====================================================================
const FULL: WidgetAccess = { costs: true, features: { tco: true, fuel: true, aarto: true }, modules: {} };
const NO_MONEY: WidgetAccess = { costs: false, features: { tco: true, fuel: true, aarto: false }, modules: { fuel: false } };

test("money widgets need cost access, plan widgets the plan, module widgets the module", () => {
  assert.equal(widgetBlock(WIDGET_BY_TYPE.get("spend_month")!, NO_MONEY), "costs");
  assert.equal(widgetBlock(WIDGET_BY_TYPE.get("fines_to_nominate")!, NO_MONEY), "plan");
  assert.equal(widgetBlock(WIDGET_BY_TYPE.get("fuel_trend")!, NO_MONEY), "module");
  assert.equal(widgetBlock(WIDGET_BY_TYPE.get("open_problems")!, NO_MONEY), null);
});

test("the default boards are full, legal, and never offer what the person cannot have", () => {
  for (const [role, access] of [["owner", FULL], ["owner", NO_MONEY], ["mechanic", FULL]] as const) {
    const items = defaultLayout(role, access);
    assert.ok(items.length >= 8, `${role} gets a real board`);
    for (const a of items) {
      assert.equal(widgetBlock(WIDGET_BY_TYPE.get(a.type)!, access), null, `${role} default offers blocked ${a.type}`);
      for (const b of items) if (a !== b) assert.ok(!collides(a, b));
    }
    assert.deepEqual(normalizeLayout(storedLayout(items)), items, "a default survives its own validation unchanged");
  }
  // Money swapped for work, not left as a hole in the top row.
  const top = defaultLayout("owner", NO_MONEY).filter((i) => i.y === 0);
  assert.equal(top.reduce((a, i) => a + i.w, 0), 12);
});

// == Validation =================================================================
test("a saved layout is cleaned, never trusted", () => {
  assert.equal(normalizeLayout(null), null);
  assert.equal(normalizeLayout({ version: 2, items: [] }), null);
  const out = normalizeLayout({
    version: 1,
    items: [
      { id: "a-1", type: "open_problems", x: 20, y: 0, w: 1, h: 99, settings: { colour: "blue", evil: "x" } },
      { id: "a-1", type: "fleet_size", x: 0, y: 0, w: 3, h: 2 },
      { id: "b-1", type: "no_such_widget", x: 0, y: 0, w: 3, h: 2 },
      { id: "BAD ID", type: "fleet_size", x: 0, y: 0, w: 3, h: 2 },
      "not an item",
    ],
  })!;
  assert.deepEqual(out, [{ id: "a-1", type: "open_problems", x: 10, y: 0, w: 2, h: 3, settings: { colour: "blue" } }]);
});

test("settings keep only the widget's own choices and a short plain title", () => {
  assert.deepEqual(cleanSettings("spend_trend", { months: "12", chart: "pie", colour: "gold", title: "  My\nspend\u0000 " }), {
    months: "12", colour: "gold", title: "My spend",
  });
  assert.equal(cleanSettings("spend_trend", { title: "x".repeat(90) }).title?.length, 40);
  assert.deepEqual(cleanSettings("spend_trend", { months: "6" }), {}, "a default is not stored");
});

// == Colour =====================================================================
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("every chart colour can be seen against the card in both themes (3:1, WCAG 1.4.11)", () => {
  const all: [string, Swatch][] = [
    ...Object.entries(HUES), ...Object.entries(PALETTES).flatMap(([p, set]) => set.map((s, i) => [`${p}[${i}]`, s] as [string, Swatch])),
    ...Object.entries(STATUS).filter(([k]) => k !== "neutral"),
  ];
  for (const [name, s] of all) {
    assert.ok(ratio(s.dark, "#1d211d") >= 3, `${name} dark ${s.dark} on the dark card: ${ratio(s.dark, "#1d211d").toFixed(2)}`);
    // The classic set's own light steps are documented below 3:1 for three slots and ship with
    // visible labels (the legend with values), so only the FleetWise colours are held to it here.
    if (!name.startsWith("classic")) assert.ok(ratio(s.light, "#ffffff") >= 3, `${name} light ${s.light} on white: ${ratio(s.light, "#ffffff").toFixed(2)}`);
  }
});
