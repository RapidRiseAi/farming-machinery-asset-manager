/**
 * A head-only count never goes through must() or soft().
 *
 * must() and soft() hand back a read's rows. A `{ count: "exact", head: true }` read has no
 * rows, so taking `count` from what must() returned reads it from null. /admin/usage did that
 * on 11 November 2026 and crashed ("Cannot destructure property 'count' ... as it is null");
 * a cast hid it from the compiler. Check the read with must(), then take `.count` from the
 * read's own result.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const SRC = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

/** The argument text of each must(...) and soft(...) call, brackets inside strings skipped. */
function wrappedReads(code: string): string[] {
  const out: string[] = [];
  const call = /\b(?:must|soft)\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(code))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    let i = start;
    for (; i < code.length && depth > 0; i += 1) {
      const c = code[i];
      if (quote) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
    }
    out.push(code.slice(start, i - 1));
  }
  return out;
}

const headOnly = (args: string) => /\bhead:\s*true\b/.test(args);

test("the check catches the 11 November crash and passes its fix", () => {
  const crashed = `
    const { count: plannedTrips } = must(
      await svc.from("trip_routes").select("trip_id", { count: "exact", head: true }).gte("planned_at", \`\${month}T00:00:00+02:00\`),
      "admin-usage:planned",
    ) as unknown as { count: number | null };`;
  const fixed = `
    const planned = await svc.from("trip_routes").select("trip_id", { count: "exact", head: true });
    must(planned, "admin-usage:planned");
    const plannedTrips = planned.count;`;
  assert.equal(wrappedReads(crashed).filter(headOnly).length, 1);
  assert.equal(wrappedReads(fixed).filter(headOnly).length, 0);
  // Brackets inside strings do not end the call early, and mustAll is not must.
  assert.deepEqual(wrappedReads(`must(read(")"), "a(b")`), [`read(")"), "a(b"`]);
  assert.deepEqual(wrappedReads(`mustAll([a, b], "w")`), []);
});

test("no head-only count is passed to must() or soft()", () => {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const code = readFileSync(file, "utf8");
    if (!/\b(?:must|soft)\(/.test(code)) continue;
    for (const args of wrappedReads(code)) {
      if (headOnly(args)) found.push(`${relative(SRC, file)}: ${args.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  assert.deepEqual(found, [], "check the read with must(read, where), then use read.count");
});
