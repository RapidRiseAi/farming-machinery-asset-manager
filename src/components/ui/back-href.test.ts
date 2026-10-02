/**
 * A back link that honours `?from=` must never leave the product.
 *
 * The parameter is attacker-writable, so every way a browser can be talked into treating
 * a "path" as another origin is pinned here, next to the ordinary case it exists for.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { backHref } from "./back-href";

test("returns to the filtered list the person came from", () => {
  assert.equal(backHref("/jobcards?status=open&q=tractor", "/jobcards"), "/jobcards?status=open&q=tractor");
  assert.equal(backHref(["/documents?type=quote", "/x"], "/documents"), "/documents?type=quote");
});

test("falls back to the list root when there is no from", () => {
  assert.equal(backHref(undefined, "/jobcards"), "/jobcards");
  assert.equal(backHref(null, "/jobcards"), "/jobcards");
  assert.equal(backHref("", "/jobcards"), "/jobcards");
  assert.equal(backHref([], "/jobcards"), "/jobcards");
});

test("refuses anything that could reach another origin", () => {
  for (const hostile of [
    "//evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "evil.example/path",
    "/\\evil.example",
    `/${String.fromCharCode(9)}/evil.example`,
    `/${String.fromCharCode(10)}/evil.example`,
    `/${String.fromCharCode(0x7f)}x`,
  ]) {
    assert.equal(backHref(hostile, "/jobcards"), "/jobcards", JSON.stringify(hostile));
  }
});
