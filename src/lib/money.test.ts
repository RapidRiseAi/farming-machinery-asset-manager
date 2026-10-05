import assert from "node:assert/strict";
import test from "node:test";
import { parseRandsToCents } from "./money";

test("a decimal comma is a decimal, never a thousands separator", () => {
  assert.equal(parseRandsToCents("250,00"), 25_000);
  assert.equal(parseRandsToCents("50,00"), 5_000);
  assert.equal(parseRandsToCents("1 500,50"), 150_050);
  assert.equal(parseRandsToCents("12,5"), 1_250);
  assert.equal(parseRandsToCents(",5"), 50);
});

test("thousands in threes, with spaces, commas or dots, and the R in front", () => {
  assert.equal(parseRandsToCents("R250"), 25_000);
  assert.equal(parseRandsToCents("R 1 500"), 150_000);
  assert.equal(parseRandsToCents("1 500"), 150_000);
  assert.equal(parseRandsToCents("1 500"), 150_000);
  assert.equal(parseRandsToCents("1,500"), 150_000);
  assert.equal(parseRandsToCents("1,234,567"), 123_456_700);
  assert.equal(parseRandsToCents("1,150.5"), 115_050);
  assert.equal(parseRandsToCents("1.500,50"), 150_050);
});

test("a dot alone is the decimal point, as it always was", () => {
  assert.equal(parseRandsToCents("250.5"), 25_050);
  assert.equal(parseRandsToCents("0.99"), 99);
  assert.equal(parseRandsToCents("1500"), 150_000);
  assert.equal(parseRandsToCents("-12.30"), -1_230);
});

test("blank, ambiguous or not a sum is refused", () => {
  assert.equal(parseRandsToCents(""), null);
  assert.equal(parseRandsToCents("   "), null);
  assert.equal(parseRandsToCents(null), null);
  assert.equal(parseRandsToCents("1,2345"), null);
  assert.equal(parseRandsToCents("1,50,000"), null);
  assert.equal(parseRandsToCents("abc"), null);
  assert.equal(parseRandsToCents("1.2.3"), null);
  assert.equal(parseRandsToCents("R"), null);
});
