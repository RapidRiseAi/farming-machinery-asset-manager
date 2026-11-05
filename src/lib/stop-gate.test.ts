/**
 * Every server action that acts on a farm passes the stop gate, checked action by action.
 *
 * A server action is an endpoint: a tab opened before a farm was paused, or a direct POST,
 * reaches it without the (app) layout's billing gate ever running. The role helpers
 * (requireRole, requireFarmRole, requireCurrentFarmRole, requireApiRole,
 * requireFarmPermission) ask the gate themselves; an action with a guard of its own must
 * call requireUsableFarm or farmIsUsable.
 *
 * Per ACTION, not per file (review round 5, finding gate-1): a file-wide check passed the
 * dashboard because one of its actions called requireRole, while its two meter-reading
 * actions saved readings for a paused farm; and it never looked at a file that authorised
 * with farmPermissionState. Each exported action's own body is read, with the same-file
 * helpers it calls, comments left out.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

const SRC = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

/**
 * Action files a stopped farm, or nobody's farm, must still reach. Each says why; a new
 * entry needs the same.
 */
const OPEN_ON_PURPOSE: Record<string, string> = {
  "app/(auth)/activate/actions.ts": "the pay screen of a farm that has not paid yet",
  "app/(auth)/suspended/actions.ts": "the pay screen of a paused farm",
  "app/(auth)/closed/actions.ts": "reopening a closed farm",
  "app/(app)/billing/actions.ts":
    "billing itself: paying, the card, cancelling (setCancellation refuses a paused farm) and slot and plan changes (the engine refuses them while paused)",
  "app/(app)/help/actions.ts": "a paused farm can still ask Rapid Rise for help",
  "app/(app)/account/actions.ts": "the person's own account (language, password), not farm data",
  "app/(app)/notifications/actions.ts": "the person's own notifications",
  "app/(app)/admin/ai/actions.ts": "Rapid Rise only (requireRrAdmin)",
  "app/(app)/admin/billing/actions.ts": "Rapid Rise only (requireRrAdmin)",
};

/** Single actions that touch no farm data, by "file#action". */
const OPEN_ACTIONS: Record<string, string> = {
};

/** Authorises a person, but asks nothing about the farm's billing. */
const AUTHORISES = /\b(requireProfile|farmPermissionState|effectiveFarmRole|getProfile)\(/;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** The text of every top-level function (exported or not), by name. */
function functionsOf(text: string): Map<string, { exported: boolean; body: string }> {
  const out = new Map<string, { exported: boolean; body: string }>();
  const re = /^(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const open = text.indexOf("{", text.indexOf(")", match.index));
    let depth = 0;
    let end = open;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.set(match[2], { exported: Boolean(match[1]), body: text.slice(match.index, end + 1) });
  }
  return out;
}

/** Whether `body` calls a gate itself. requireRole for workshop or Rapid Rise only does not count. */
function callsGate(body: string): boolean {
  if (/\b(requireFarmRole|requireCurrentFarmRole|requireFarmPermission|requireUsableFarm|farmIsUsable)\(/.test(body)) {
    return true;
  }
  for (const m of body.matchAll(/\b(requireRole|requireApiRole)\(\s*\[([^\]]*)\]/g)) {
    const roles = [...m[2].matchAll(/["']([a-z_]+)["']/g)].map((r) => r[1]);
    if (roles.some((r) => r !== "workshop" && r !== "rr_admin")) return true;
  }
  return false;
}

/** An action is gated when it, or a same-file helper it reaches, calls a gate. */
function gated(name: string, fns: Map<string, { exported: boolean; body: string }>, seen = new Set<string>()): boolean {
  const fn = fns.get(name);
  if (!fn || seen.has(name)) return false;
  seen.add(name);
  if (callsGate(fn.body)) return true;
  for (const other of fns.keys()) {
    if (other !== name && new RegExp(`\\b${other}\\(`).test(fn.body) && gated(other, fns, seen)) return true;
  }
  return false;
}

/** Whether `name`, or a same-file helper it reaches, authorises a person. */
function authorises(name: string, fns: Map<string, { exported: boolean; body: string }>, seen = new Set<string>()): boolean {
  const fn = fns.get(name);
  if (!fn || seen.has(name)) return false;
  seen.add(name);
  if (AUTHORISES.test(fn.body)) return true;
  for (const other of fns.keys()) {
    if (other !== name && new RegExp(`\\b${other}\\(`).test(fn.body) && authorises(other, fns, seen)) return true;
  }
  return false;
}

function actionFiles(): Array<{ key: string; fns: Map<string, { exported: boolean; body: string }> }> {
  return sources(SRC)
    .map((file) => ({ file, text: readFileSync(file, "utf8") }))
    .filter(({ text }) => /^\s*["']use server["'];?/m.test(text))
    .map(({ file, text }) => ({ key: relative(SRC, file).split(sep).join("/"), fns: functionsOf(stripComments(text)) }));
}

test("every server action that authorises a person also passes the stop gate", () => {
  const offenders: string[] = [];
  for (const { key, fns } of actionFiles()) {
    if (key in OPEN_ON_PURPOSE) continue;
    for (const [name, fn] of fns) {
      if (!fn.exported || `${key}#${name}` in OPEN_ACTIONS) continue;
      if (authorises(name, fns) && !gated(name, fns)) offenders.push(`${key}#${name}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `server actions that authorise with no stop gate on their path (add requireUsableFarm, or list them with a reason): ${offenders.join(", ")}`,
  );
});

test("the check itself: a gate in a sibling action or a comment does not count", () => {
  const fns = functionsOf(
    stripComments(`
export async function dismiss() { await requireRole(["owner"]); }
export async function save() { const p = await requireProfile(); // requireUsableFarm(f, p)
  await helper(p); }
async function helper(p) { await effectiveFarmRole(f, p); }
export async function staff() { await requireRole(["workshop", "rr_admin"]); const p = await requireProfile(); }
export async function ok() { const p = await requireProfile(); await guard(p); }
async function guard(p) { await requireUsableFarm(f, p); }
`),
  );
  assert.equal(gated("dismiss", fns), true);
  assert.equal(gated("save", fns), false, "a comment and a sibling's requireRole are not this action's gate");
  assert.equal(gated("staff", fns), false, "requireRole for workshop or Rapid Rise only is no gate");
  assert.equal(gated("ok", fns), true, "a gate in a same-file helper counts");
});

test("every file and action listed as open on purpose still exists", () => {
  for (const key of Object.keys(OPEN_ON_PURPOSE)) {
    const text = readFileSync(join(SRC, ...key.split("/")), "utf8");
    assert.match(text, /^\s*["']use server["'];?/m, `${key} is no longer a server action file`);
  }
  for (const entry of Object.keys(OPEN_ACTIONS)) {
    const [file, action] = entry.split("#");
    const text = readFileSync(join(SRC, ...file.split("/")), "utf8");
    assert.match(text, new RegExp(`export\\s+async\\s+function\\s+${action}\\(`), `${entry} no longer exists`);
  }
});
