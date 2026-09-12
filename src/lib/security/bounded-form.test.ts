import assert from "node:assert/strict";
import { test } from "node:test";
import { readBoundedFormData } from "./bounded-form";

test("multipart reader accepts fields without content-length", async () => {
  const fd = new FormData(); fd.set("hello", "world");
  const req = new Request("https://example.test", { method: "POST", body: fd });
  assert.equal((await readBoundedFormData(req, 1024)).get("hello"), "world");
});
test("multipart reader enforces actual bytes without trusting content-length", async () => {
  const req = new Request("https://example.test", { method: "POST", body: "x".repeat(100), headers: { "content-length": "1" } });
  await assert.rejects(readBoundedFormData(req, 50), RangeError);
});
