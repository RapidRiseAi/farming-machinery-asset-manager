import test from "node:test";
import assert from "node:assert/strict";

import { OWNED_FIELD, ownedKeys, ownedUpdate, owns, ownsAny } from "./partial-form";

/** A real FormData, so these exercise the interface the actions are handed. */
function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

test("a form with no marker owns everything", () => {
  const fd = form({ anything: "1" });
  assert.equal(ownedKeys(fd), null);
  assert.equal(owns(fd, "anything"), true);
  assert.equal(owns(fd, "something_it_never_heard_of"), true);
});

test("a form with a marker owns only what it lists", () => {
  const fd = form({ [OWNED_FIELD]: "a b", a: "1" });
  assert.deepEqual(ownedKeys(fd), ["a", "b"]);
  assert.equal(owns(fd, "a"), true);
  assert.equal(owns(fd, "b"), true);
  assert.equal(owns(fd, "c"), false);
});

test("absent and empty are different answers", () => {
  // Absent means "I am the whole form". Empty means "I own none of these", which is what
  // a form posting only columns outside the set looks like.
  assert.equal(ownedKeys(form({})), null);
  assert.deepEqual(ownedKeys(form({ [OWNED_FIELD]: "" })), []);
  assert.equal(owns(form({ [OWNED_FIELD]: "" }), "a"), false);
});

test("the marker tolerates commas and runs of whitespace", () => {
  assert.deepEqual(ownedKeys(form({ [OWNED_FIELD]: "a,  b\n c" })), ["a", "b", "c"]);
});

test("ownsAny judges a whole-form post on what it actually carries", () => {
  assert.equal(ownsAny(form({ phone: "x" }), ["phone", "email"]), true);
  assert.equal(ownsAny(form({ other: "x" }), ["phone", "email"]), false);
  assert.equal(ownsAny(form({ [OWNED_FIELD]: "phone" }), ["phone", "email"]), true);
  assert.equal(ownsAny(form({ [OWNED_FIELD]: "area" }), ["phone", "email"]), false);
});

test("ownedUpdate omits the columns the form does not own", () => {
  /*
   * The point of the whole module. `/contractor/settings` writes one `.update()` over
   * every column; a partial form that included them all would reset `vat_registered` to
   * false and the invoice prefix to "INV", both of which appear on a tax invoice.
   * Omitted is not the same as defaulted: an omitted key is not sent at all.
   */
  const fd = form({ [OWNED_FIELD]: "phone email", phone: "082", email: "a@b.c" });
  const update = ownedUpdate(fd, {
    phone: () => String(fd.get("phone") ?? ""),
    email: () => String(fd.get("email") ?? ""),
    vat_registered: () => fd.get("vat_registered") != null,
    doc_prefix_invoice: () => String(fd.get("doc_prefix_invoice") ?? "INV"),
  });

  assert.deepEqual(update, { phone: "082", email: "a@b.c" });
  assert.equal("vat_registered" in update, false);
  assert.equal("doc_prefix_invoice" in update, false);
});

test("ownedUpdate includes a false and an empty string it DOES own", () => {
  // Falsy is not absent. Unticking a box the form owns has to be able to write false,
  // and clearing a text box it owns has to be able to write "".
  const fd = form({ [OWNED_FIELD]: "vat_registered note" });
  const update = ownedUpdate(fd, {
    vat_registered: () => fd.get("vat_registered") != null,
    note: () => String(fd.get("note") ?? ""),
  });
  assert.deepEqual(update, { vat_registered: false, note: "" });
});

test("ownedUpdate on a whole-form post includes every column", () => {
  const fd = form({ phone: "082" });
  const update = ownedUpdate(fd, {
    phone: () => String(fd.get("phone") ?? ""),
    email: () => String(fd.get("email") ?? ""),
  });
  assert.deepEqual(update, { phone: "082", email: "" });
});
