import assert from "node:assert/strict";
import { test } from "node:test";

import { displayValue, fieldInputName, groupDefinitions, parseChoices, valueFromSheet, valuesFromForm, type FieldDefinition } from "./custom-fields";

const def = (over: Partial<FieldDefinition>): FieldDefinition => ({
  id: "d1", key: "k", label: "Label", field_type: "text", unit: null, choices: [], required: false,
  visibility: "everyone", group_label: null, sort_order: 0, retired_at: null, ...over,
});

test("choices: one per line or comma-separated, trimmed, no blanks or repeats", () => {
  assert.deepEqual(parseChoices(" North, South\nNorth\n\n East "), ["North", "South", "East"]);
  assert.deepEqual(parseChoices(""), []);
});

test("a submitted form becomes typed values for the database to check again", () => {
  const defs = [
    def({ id: "a", field_type: "text" }),
    def({ id: "b", field_type: "number", unit: "L" }),
    def({ id: "c", field_type: "yes_no" }),
    def({ id: "d", field_type: "date" }),
    def({ id: "e", field_type: "text", retired_at: "2026-11-01" }),
    def({ id: "f", field_type: "yes_no" }),
  ];
  const form = new FormData();
  form.set(fieldInputName("a"), "  Green  ");
  form.set(fieldInputName("b"), "350,5");
  form.set(`${fieldInputName("c")}__shown`, "1");
  form.set(fieldInputName("d"), "");
  form.set(fieldInputName("e"), "ignored");
  assert.deepEqual(valuesFromForm(form, defs), { a: "Green", b: 350.5, c: false, d: null },
    "an unticked box shown on the form is false; an empty input clears; a retired field and an absent box are left alone");
  form.set(fieldInputName("c"), "1");
  assert.equal(valuesFromForm(form, defs).c, true);
});

test("values read as words, with the unit, and markup is just text", () => {
  const v = (over: object) => ({ definition_id: "x", value_text: null, value_number: null, value_date: null, value_bool: null, ...over });
  assert.equal(displayValue(def({ field_type: "number", unit: "L" }), v({ value_number: "350.5" }), "Yes", "No"), "350.5 L");
  assert.equal(displayValue(def({ field_type: "yes_no" }), v({ value_bool: false }), "Yes", "No"), "No");
  assert.equal(displayValue(def({ field_type: "text" }), v({ value_text: "<b>x</b>" }), "Yes", "No"), "<b>x</b>",
    "returned as a string; React renders it as text");
  assert.equal(displayValue(def({}), undefined, "Yes", "No"), null);
});

test("a spreadsheet cell becomes a typed value, or is skipped rather than guessed", () => {
  const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : v === "29/07/2026" ? "2026-07-29" : null);
  assert.equal(valueFromSheet(def({ field_type: "number" }), " 1 250,5 ", date), 1250.5);
  assert.equal(valueFromSheet(def({ field_type: "number" }), "lots", date), undefined);
  assert.equal(valueFromSheet(def({ field_type: "yes_no" }), "Ja", date), true);
  assert.equal(valueFromSheet(def({ field_type: "yes_no" }), "nee", date), false);
  assert.equal(valueFromSheet(def({ field_type: "yes_no" }), "maybe", date), undefined);
  assert.equal(valueFromSheet(def({ field_type: "date" }), "29/07/2026", date), "2026-07-29");
  assert.equal(valueFromSheet(def({ field_type: "date" }), "07/29/2026", date), undefined, "month-first is never guessed");
  assert.equal(valueFromSheet(def({ field_type: "choice", choices: ["North", "South"] }), "north", date), "North",
    "a choice matches whatever its case, and is stored as the list spells it");
  assert.equal(valueFromSheet(def({ field_type: "choice", choices: ["North"] }), "East", date), undefined);
  assert.equal(valueFromSheet(def({ field_type: "text" }), "   ", date), undefined, "an empty cell changes nothing");
});

test("fields read in groups, ungrouped first, then by the business's order", () => {
  const grouped = groupDefinitions([
    def({ id: "1", label: "B", group_label: "Finance", sort_order: 20 }),
    def({ id: "2", label: "A", group_label: null, sort_order: 30 }),
    def({ id: "3", label: "C", group_label: "Finance", sort_order: 10 }),
  ]);
  assert.deepEqual(grouped.map((g) => [g.group, g.fields.map((f) => f.id)]), [[null, ["2"]], ["Finance", ["3", "1"]]]);
});
