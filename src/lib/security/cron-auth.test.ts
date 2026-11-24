import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Every scheduled route checks its bearer secret in constant time (A6). /api/push/send compared it
// with a plain !== until 19 Nov 2026: the time a refusal took said how much of a guess was right.
function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? routes(full) : name === "route.ts" ? [full] : [];
  });
}

test("every scheduled route checks its secret with the constant-time helper", () => {
  const files = [...routes("src/app/api/cron"), "src/app/api/push/send/route.ts"];
  assert.ok(files.length >= 5, `found ${files.length} scheduled routes`);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // bearerMatches, or the WhatsApp worker's validWorkerAuthorization (hashed, then timingSafeEqual).
    assert.match(source, /bearerMatches\(|validWorkerAuthorization\(/, `${file} must use a constant-time check`);
    assert.doesNotMatch(source, /authHeader\s*!==|!==\s*`Bearer /, `${file} compares the secret with !==`);
  }
});
