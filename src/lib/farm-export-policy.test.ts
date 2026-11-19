import assert from "node:assert/strict";
import test from "node:test";
import { exportArchivePath, exportRefusal } from "./farm-export-policy";

test("only permitted roles export and unknown lifecycle failures close access", () => {
  for (const role of [null, "operator", "mechanic", "workshop"]) {
    assert.equal(exportRefusal(role, "ok")?.status, 403);
  }
  assert.equal(exportRefusal("owner", "ok"), null);
  assert.equal(exportRefusal("manager", "ok"), null);
  assert.equal(exportRefusal("owner", "pending")?.status, 402);
  assert.equal(exportRefusal("owner", null)?.status, 503);
  assert.equal(exportRefusal("owner", "unknown", { state: "retrieval", reason: "billing" })?.status, 503);
  assert.equal(exportRefusal("owner", "suspended", null)?.status, 503);
});

test("retrieval is owner-only and the boundary comes from the lifecycle", () => {
  const retrieval = { state: "retrieval", reason: "billing" };
  for (const gate of ["suspended", "closed"]) {
    assert.equal(exportRefusal("owner", gate, retrieval), null);
    assert.equal(exportRefusal("manager", gate, retrieval)?.error, "retrieval-owner-only");
    assert.equal(exportRefusal("owner", gate, { state: "closed", reason: "billing" })?.error, "retrieval-ended");
  }
  assert.equal(exportRefusal("owner", "closed", { state: "closed", reason: "rapid_rise" }), null);
  assert.equal(exportRefusal("rr_admin", "closed"), null);
});

test("archive paths stay portable, scoped, unique and outside private chat", () => {
  for (const path of ["f/../../secret", "f/C:\\secret", "f/%2e%2e/file", "f/CON", "f/a\n.csv", "f/a...", "f/.."]) {
    const name = exportArchivePath("machine-docs", path, "f");
    assert.match(name, /^machine-docs\/[0-9a-f]{64}-[a-zA-Z0-9._-]+$/);
    assert.equal(name.split("/").length, 2);
    assert.ok(!name.endsWith("."));
  }
  assert.notEqual(exportArchivePath("machine-docs", "f/a?.pdf", "f"), exportArchivePath("machine-docs", "f/a*.pdf", "f"));
  assert.equal(exportArchivePath("machine-docs", "f/a.pdf", "f"), exportArchivePath("machine-docs", "f/a.pdf", "f"));
  for (const bucket of ["chat-files", "command-audio", "../machine-docs", "docs\r\n"]) {
    assert.throws(() => exportArchivePath(bucket, "f/a.pdf", "f"));
  }
  assert.throws(() => exportArchivePath("machine-docs", "other/a.pdf", "f"));
  assert.throws(() => exportArchivePath("machine-docs", "f/", "f"));
});
