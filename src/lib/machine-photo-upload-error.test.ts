import assert from "node:assert/strict";
import test from "node:test";
import { defaultMeterFor } from "./machine-options";
import { looksLikeImage, photoUploadErrorKey } from "./machine-photo-upload-error";

test("defaultMeterFor: odometer for road vehicles, none for implements, hours otherwise", () => {
  assert.equal(defaultMeterFor("bakkie"), "km");
  assert.equal(defaultMeterFor("truck"), "km");
  assert.equal(defaultMeterFor("implement"), "none");
  assert.equal(defaultMeterFor("tractor"), "hours");
  assert.equal(defaultMeterFor("harvester"), "hours");
  assert.equal(defaultMeterFor(null), "hours");
});

test("photoUploadErrorKey never returns raw text, and maps the known causes", () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(photoUploadErrorKey(new Error("new row violates row-level security policy"), true), "machine.uploadFailed");
    assert.equal(photoUploadErrorKey(new Error("anything"), false), "machine.uploadOffline");
    assert.equal(photoUploadErrorKey(new TypeError("Failed to fetch"), true), "machine.uploadOffline");
    assert.equal(photoUploadErrorKey({ statusCode: "413", message: "Payload too large" }, true), "machine.uploadTooLarge");
    assert.equal(
      photoUploadErrorKey({ message: "The object exceeded the maximum allowed size" }, true),
      "machine.uploadTooLarge",
    );
    assert.equal(photoUploadErrorKey(new DOMException("bad image", "InvalidStateError"), true), "machine.uploadNotImage");
    assert.equal(photoUploadErrorKey(null, true), "machine.uploadFailed");
  } finally {
    console.warn = quiet;
  }
});

test("looksLikeImage lets photos and untyped files through, refuses documents", () => {
  assert.equal(looksLikeImage(new File([""], "a.jpg", { type: "image/jpeg" })), true);
  assert.equal(looksLikeImage(new File([""], "a", { type: "" })), true);
  assert.equal(looksLikeImage(new File([""], "a.pdf", { type: "application/pdf" })), false);
});
