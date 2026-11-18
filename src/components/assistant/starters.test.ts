import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Suggested questions never start paid work by themselves (BRIEF section 19). A starter
 * fills the typing box and the person sends it; an answer's suggested action is a link to a
 * screen. This reads the one place starters are drawn, because a starter that called the
 * turn on tap would spend the business's assistance budget without anybody asking.
 */
const source = readFileSync(join(process.cwd(), "src/components/assistant/assistant-client.tsx"), "utf8");

test("a starter only fills the typing box", () => {
  const start = source.indexOf("{examples.map((example) => (");
  assert.ok(start > 0, "the starters block moved: re-point this test at it");
  const block = source.slice(start, source.indexOf("))}", start));
  assert.match(block, /onClick=\{\(\) => setTypedInput\(example\)\}/);
  assert.doesNotMatch(block, /submitRequest|fetch\(|transcribe|voice-session/);
});

test("an answer's suggested action is a link, not a request", () => {
  const at = source.indexOf("turn.action ? (");
  assert.ok(at > 0, "the answer action moved: re-point this test at it");
  const block = source.slice(at, at + 200);
  assert.match(block, /<Link href=\{turn\.action\.href\}/);
});
