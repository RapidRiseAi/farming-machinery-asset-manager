import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hiddenMenuHrefs, moduleOn, simpleDriverMode, MODULE_KEYS, moduleSettingKey } from "./modules";
import { mergeSettings, OWNED_FIELD } from "./settings";
import { t } from "@/lib/i18n";

const owner = { isOperator: false, isWorkshop: false, isAdmin: false };
const driver = { isOperator: true, isWorkshop: false, isAdmin: false };
const menu = ["/driver", "/machines", "/faults", "/fuel", "/driver/activity", "/help", "/install", "/tyres"];

test("an account that never touched the setting sees every module but trips", () => {
  assert.deepEqual([...hiddenMenuHrefs(null, owner, menu)], ["/trips"]);
  assert.deepEqual([...hiddenMenuHrefs({}, driver, menu)], ["/trips"]);
  for (const m of MODULE_KEYS) assert.equal(moduleOn({}, m), m !== "trips");
  assert.equal(simpleDriverMode({}), false);
});

test("trips start on only for a business whose work is trips, and the owner's choice wins", () => {
  assert.equal(moduleOn({}, "trips", "goods_transport"), true);
  assert.equal(moduleOn({}, "trips", "game_drive"), true);
  assert.equal(moduleOn({}, "trips", "farm"), false);
  assert.equal(moduleOn({}, "trips", "other"), false);
  assert.equal(moduleOn({ module_trips: true }, "trips", "farm"), true);
  assert.equal(moduleOn({ module_trips: false }, "trips", "delivery"), false);
  assert.deepEqual([...hiddenMenuHrefs({}, { ...owner, company: "delivery" }, menu)], []);
});

test("a switched-off module leaves the menus; nothing else does", () => {
  const hidden = hiddenMenuHrefs({ module_fuel: false, module_tyres: false }, owner, menu);
  assert.deepEqual([...hidden].sort(), ["/fuel", "/trips", "/tyres"]);
});

test("simple mode leaves a driver home, help and install, and changes nothing for owners", () => {
  const hidden = hiddenMenuHrefs({ simple_driver_mode: true }, driver, menu);
  assert.deepEqual(menu.filter((h) => !hidden.has(h)), ["/driver", "/help", "/install"]);
  assert.deepEqual([...hiddenMenuHrefs({ simple_driver_mode: true }, owner, menu)], ["/trips"]);
});

test("Rapid Rise staff and workshops are never trimmed by one farm's choice", () => {
  const settings = { module_fuel: false, simple_driver_mode: true };
  assert.equal(hiddenMenuHrefs(settings, { ...owner, isAdmin: true }, menu).size, 0);
  assert.equal(hiddenMenuHrefs(settings, { ...owner, isWorkshop: true }, menu).size, 0);
});

test("the settings form owns the switches: unticked is off, untouched groups keep theirs", () => {
  const form = new FormData();
  form.set(OWNED_FIELD, [...MODULE_KEYS.map(moduleSettingKey), "simple_driver_mode"].join(" "));
  for (const m of MODULE_KEYS) if (m !== "fines") form.set(moduleSettingKey(m), "on");
  form.set("simple_driver_mode", "on");
  const merged = mergeSettings({ vat_rate_bps: 0, module_fines: true }, form);
  assert.equal(merged.module_fines, false);
  assert.equal(merged.module_fuel, true);
  assert.equal(merged.simple_driver_mode, true);
  assert.equal(merged.vat_rate_bps, 0, "another group's value is carried over");
  // A form for another group leaves the switches as stored.
  const other = new FormData();
  other.set(OWNED_FIELD, "quiet_hours_start quiet_hours_end");
  other.set("quiet_hours_start", "21");
  const kept = mergeSettings({ module_fines: false, simple_driver_mode: true }, other);
  assert.equal(kept.module_fines, false);
  assert.equal(kept.simple_driver_mode, true);
});

test("every module has a label in both languages, and the layout applies the filter", () => {
  for (const m of MODULE_KEYS) for (const lang of ["en", "af"] as const) {
    assert.notEqual(t(`settings.module.${m}`, lang), `settings.module.${m}`);
  }
  const layout = readFileSync(join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8");
  assert.ok(layout.includes("hiddenMenuHrefs(farmSettings"));
  assert.ok(layout.includes("const groups = trim(allGroups)") && layout.includes("const tailGroups = trim(allTailGroups)"));
});
