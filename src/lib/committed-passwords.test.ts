import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The repo is public. Until 2026-10-14 it carried the passwords of the demo accounts and of
 * the click-through test owner, all of them accounts on production and one of them Rapid
 * Rise's admin, so anyone reading GitHub could sign in. They were rotated and now live only
 * in `.env.local` (`DEMO_PASSWORD`, `CLICKTHROUGH_PASSWORD`). These tests keep it that way:
 * the retired ones never come back, and no script or seed holds a password of its own.
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SKIP = new Set(["node_modules", ".next", ".git", ".vercel", ".turbo", "coverage"]);
const TEXT = /\.(?:[cm]?[jt]sx?|sql|md|json|ya?ml|sh|ps1|txt|toml|html|css)$|^\.env\.example$/;

function files(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, keep);
    return keep(entry.name) ? [path] : [];
  });
}

const repoPath = (file: string) => relative(REPO, file).replace(/\\/g, "/");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The retired passwords by length and SHA-256, so this file does not print them again. */
const RETIRED = [
  { length: 15, sha256: "9de154b4f90c3ca2a9f9f4357ccdb4256f4e9cb91f35c1966b15979ecc15a3a8" },
  { length: 17, sha256: "1daa6679d001655ba43088938d89b7cdd9b6a43c3f22d94d400ece8f5c0c3e26" },
];

/** Every token a password could be in text: runs between spaces, quotes and brackets. */
const TOKEN = /[^\s`'"*(),;<>[\]{}|]+/g;

test("no retired password appears anywhere in the repo", () => {
  const lengths = new Set(RETIRED.map((r) => r.length));
  const hashes = new Set(RETIRED.map((r) => r.sha256));
  const found: string[] = [];
  for (const file of files(REPO, (name) => TEXT.test(name))) {
    for (const token of readFileSync(file, "utf8").match(TOKEN) ?? []) {
      if (lengths.has(token.length) && hashes.has(sha256(token))) found.push(repoPath(file));
    }
  }
  assert.deepEqual(found, [], "a retired password is back in the repo: remove it (the repo is public)");
});

/** A password written as a literal: `PASSWORD = "..."`, `password: '...'`, `pw text := '...'`. */
const LITERALS = [
  /\b\w*passw(?:or)?d\w*\s*[:=]\s*(["'`])(?!\1)[^"'`\n]{4,}\1/gi,
  /\b(?:pw|\w*passw(?:or)?d\w*)\s+text\s*:=\s*'[^'\n]{4,}'/gi,
  /\bcrypt\(\s*'[^'\n]{4,}'/gi,
];

/** What `LITERALS` finds in one file: each match's line, for the failure message. */
function literalPasswords(text: string): number[] {
  const lines: number[] = [];
  for (const pattern of LITERALS) {
    for (const match of text.matchAll(pattern)) lines.push(text.slice(0, match.index ?? 0).split("\n").length);
  }
  return lines.sort((a, b) => a - b);
}

test("scripts and seeds read passwords from .env.local, never hold one", () => {
  const roots = ["scripts", "supabase/seed"].map((dir) => join(REPO, dir));
  const found = roots
    .flatMap((root) => files(root, (name) => /\.(?:[cm]?js|ts|sql|sh|ps1)$/.test(name)))
    .flatMap((file) => literalPasswords(readFileSync(file, "utf8")).map((line) => `${repoPath(file)}:${line}`));
  assert.deepEqual(found, [], "a password literal in a script or seed: read it from .env.local instead");
});

test("the literal check catches the shapes the retired passwords were written in", () => {
  assert.deepEqual(literalPasswords('const PASSWORD = "Hunter2!x";'), [1]);
  assert.deepEqual(literalPasswords('body: JSON.stringify({ email: "a@b.test", password: "Hunter2!x" }),'), [1]);
  assert.deepEqual(literalPasswords("declare\n  pw text := 'Hunter2!x';"), [2]);
  assert.deepEqual(literalPasswords("crypt('Hunter2!x', gen_salt('bf'))"), [1]);
  // Reading one is fine, and so is a placeholder in a message.
  assert.deepEqual(literalPasswords('const PASSWORD = readEnv("CLICKTHROUGH_PASSWORD");'), []);
  assert.deepEqual(literalPasswords("pw text := nullif(current_setting('demo.password', true), '');"), []);
  assert.deepEqual(literalPasswords("crypt(p_password, gen_salt('bf'))"), []);
});
