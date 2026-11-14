/**
 * The equipment profile's eligibility list exists twice, once in SQL (the database refuses an
 * ineligible asset on any path) and once here (the screens offer the choice). A screen that
 * offered the profile to a type the database refuses, or hid it from one the database
 * accepts, would be the "screen and engine disagree" bug CLAUDE.md warns about. This reads
 * the migration itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EQUIPMENT_ELIGIBLE_TYPES,
  MACHINE_TYPES,
  defaultMeterFor,
  isEquipmentEligible,
  machineTypesFor,
  needsClassificationReview,
  typeLabel,
} from "@/lib/machine-options";

const MIGRATION = join(process.cwd(), "supabase", "migrations", "20261114090100_equipment_profile.sql");
const ENUM_MIGRATIONS = [
  "0001_extensions_and_enums.sql",
  "20261107090000_company_types.sql",
  "20261114090000_machine_types_equipment.sql",
];

function sqlClassification(): Map<string, boolean> {
  const sql = readFileSync(MIGRATION, "utf8");
  const body = sql.slice(sql.indexOf("function app.equipment_eligible"), sql.indexOf("revoke all on function app.equipment_eligible"));
  const out = new Map<string, boolean>();
  for (const m of body.matchAll(/when '([a-z_]+)'\s+then (true|false)/g)) out.set(m[1], m[2] === "true");
  return out;
}

function sqlEnumValues(): Set<string> {
  const values = new Set<string>();
  for (const file of ENUM_MIGRATIONS) {
    const sql = readFileSync(join(process.cwd(), "supabase", "migrations", file), "utf8");
    const create = sql.match(/create type machine_type\s+as enum \(([^)]*)\)/);
    if (create) for (const v of create[1].matchAll(/'([a-z_]+)'/g)) values.add(v[1]);
    for (const v of sql.matchAll(/alter type public\.machine_type add value if not exists '([a-z_]+)'/g)) values.add(v[1]);
  }
  return values;
}

test("the screens and the database classify every type the same way", () => {
  const sql = sqlClassification();
  assert.ok(sql.size >= 21, `expected every type in the SQL classification, found ${sql.size}`);
  for (const type of MACHINE_TYPES) {
    assert.ok(sql.has(type), `${type} is not classified in app.equipment_eligible`);
    assert.equal(isEquipmentEligible(type), sql.get(type), `${type}: TS says ${isEquipmentEligible(type)}, SQL says ${sql.get(type)}`);
  }
  const eligibleInSql = [...sql].filter(([, ok]) => ok).map(([t]) => t).sort();
  assert.deepEqual([...EQUIPMENT_ELIGIBLE_TYPES].sort(), eligibleInSql);
});

test("the TS type list is exactly the database enum", () => {
  assert.deepEqual([...MACHINE_TYPES].sort(), [...sqlEnumValues()].sort());
});

test("vehicles never qualify, whatever the company", () => {
  for (const vehicle of ["tractor", "harvester", "bakkie", "truck", "truck_tractor", "car", "van", "bus", "minibus", "forklift", "earthmoving", "motorcycle", "game_viewer", "boat", "atv_other"]) {
    assert.equal(isEquipmentEligible(vehicle), false, vehicle);
  }
  for (const kind of ["pump_generator", "compressor", "workshop_tool", "implement", "trailer", "other_equipment"]) {
    assert.equal(isEquipmentEligible(kind), true, kind);
  }
  assert.equal(isEquipmentEligible(null), false);
  assert.equal(isEquipmentEligible("not_a_type"), false);
});

test("only other equipment asks for a person to look at it", () => {
  assert.equal(needsClassificationReview("other_equipment"), true);
  assert.equal(needsClassificationReview("trailer"), false);
  assert.equal(needsClassificationReview("pump_generator"), false);
});

test("every company type can register support equipment, and every new type has words in both languages", () => {
  const langs = ["farm", "game_drive", "goods_transport", "delivery", "passenger_transport", "construction"]
    .flatMap((company) => [`en@${company}`, `af@${company}`]) as Parameters<typeof machineTypesFor>[0][];
  for (const lang of langs) {
    const list = machineTypesFor(lang);
    for (const type of ["compressor", "workshop_tool", "other_equipment"]) {
      assert.ok(list.includes(type as never), `${lang}: ${type} is not offered`);
      const label = typeLabel(type, lang);
      assert.notEqual(label, `machineType.${type}`, `${lang}: ${type} has no label`);
    }
  }
});

test("a workshop tool starts with no meter, a compressor on hours", () => {
  assert.equal(defaultMeterFor("workshop_tool"), "none");
  assert.equal(defaultMeterFor("other_equipment"), "none");
  assert.equal(defaultMeterFor("compressor"), "hours");
});
