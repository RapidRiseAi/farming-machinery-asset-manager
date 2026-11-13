import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * The enforced content security policy (csp.ts) runs no inline script without this
 * response's nonce. These read the source, so a new inline script without one fails here
 * rather than silently doing nothing in the browser.
 */

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?|mjs)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every JSX <script ...> opening tag in a file, attributes included (they may span lines). */
function scriptTags(text: string): string[] {
  return [...text.matchAll(/<script\b(?:[^>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*\/?>/g)].map((m) => m[0]);
}

test("the root layout's inline scripts all carry the nonce", () => {
  const layout = readFileSync(join(SRC, "app", "layout.tsx"), "utf8");
  const tags = scriptTags(layout);
  assert.equal(tags.length, 3, "BOOT_GUARD, THEME_BOOTSTRAP and TEXT_SIZE_BOOTSTRAP");
  for (const tag of tags) assert.match(tag, /\snonce=\{nonce\}/, tag);
  assert.match(layout, /const nonce = \(await headers\(\)\)\.get\(NONCE_HEADER\)/, "the nonce comes from the middleware's header");
});

test("no script in src is written without a nonce, and nothing runs script the policy blocks", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const name = relative(process.cwd(), file);
    for (const tag of scriptTags(text)) {
      if (!/\snonce=/.test(tag)) offenders.push(`${name}: ${tag.slice(0, 80)}`);
    }
    // next/script sets its own nonce only when given one; nothing uses it today.
    if (/from\s+["']next\/script["']/.test(text)) offenders.push(`${name}: next/script needs nonce={nonce}`);
    // dangerouslySetInnerHTML on a <script> element: the element it sits on must have the nonce.
    // (On anything else it is markup, the QR pages' generated SVG, which the policy does not run.)
    for (const m of text.matchAll(/dangerouslySetInnerHTML=/g)) {
      const before = text.slice(Math.max(0, m.index - 300), m.index);
      const opener = before.slice(before.lastIndexOf("<"));
      if (/^<script\b/.test(opener) && !/\snonce=/.test(opener)) offenders.push(`${name}: inline script without a nonce`);
    }
    // What the policy blocks however it is written: script in a URL, in an attribute, or from a string.
    if (/["'`]\s*javascript:/i.test(text)) offenders.push(`${name}: a javascript: URL`);
    if (/\son(click|load|error|submit|change|input|mouse\w+|key\w+)=["']/.test(text)) offenders.push(`${name}: an inline event handler attribute`);
    if (/\beval\(|\bnew Function\(/.test(text)) offenders.push(`${name}: eval or new Function`);
  }
  assert.deepEqual(offenders, []);
});
