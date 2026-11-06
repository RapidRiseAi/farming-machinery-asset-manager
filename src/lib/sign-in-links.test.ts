/**
 * A sign-in link opens somebody's account, so it may only ever travel by email to the address
 * it opens. A partner invite once minted one for whatever address a farmer typed and showed
 * it on screen, which let any farm owner sign in as any other customer. So this is a list,
 * and a new place that mints a link must be added to it on purpose, after asking who ends up
 * holding what it makes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const relativeHits = (pattern: RegExp) =>
  sources(SRC)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path).split(sep).join("/"))
    .sort();

test("only the two email senders mint a sign-in link", () => {
  assert.deepEqual(relativeHits(/\bgenerateLink\b/), ["lib/email/invite.ts", "lib/email/partner-access.ts"]);
});

test("a minted link's raw URL is never read", () => {
  // `action_link` is the working URL. The senders use the hash, on our own confirm page.
  assert.deepEqual(relativeHits(/\.action_link\b|\baction_link\??:/), []);
});

test("nothing outside the mail code touches a minted sign-in", () => {
  assert.deepEqual(relativeHits(/\bmintSignIn\(/), [
    "app/(app)/admin/partners/actions.ts",
    "app/(app)/partners/actions.ts",
    "lib/email/partner-access.ts",
    "lib/partner-invites.ts",
  ]);
});

test("a contractor's sign-in goes to the address on their login, never a typed one", () => {
  const actions = readFileSync(join(SRC, "app/(app)/partners/actions.ts"), "utf8");
  const body = actions.slice(actions.indexOf("export async function emailPartnerSignIn"));
  const end = body.indexOf("\n}\n");
  const fn = body.slice(0, end);
  assert.ok(fn.length > 0);
  assert.doesNotMatch(fn, /formData\.get\("email"\)/);
});
