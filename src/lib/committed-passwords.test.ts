import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The repo is public. Until 2026-10-14 it carried the passwords of the demo accounts and of
 * the click-through test owner, all of them accounts on production and one of them Rapid
 * Rise's admin, so anyone reading GitHub could sign in; an older "dev logins" password sat
 * in the build log beside them. All are retired (rotated, or the accounts gone) and live
 * passwords are in `.env.local` only (`DEMO_PASSWORD`, `CLICKTHROUGH_PASSWORD`). These tests
 * keep it that way: no retired password comes back anywhere, and no committed file holds a
 * password of its own. They cannot stop someone committing a brand-new password in a shape
 * nobody thought of, which is why GitHub's secret scanning and push protection are on the
 * founder's launch checklist too.
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEXT = /\.(?:[cm]?[jt]sx?|sql|md|json|ya?ml|sh|ps1|txt|toml|html|css|py)$/;
const ENV_FILE = /^\.env(\..+)?$/;

/**
 * What could be committed: every tracked file and every untracked one git does not ignore.
 * Ignored files are never read, so a local .env.local, .env.production or a backup of one,
 * which hold real values and are never committed, cannot fail this test or be opened by it.
 */
function committable(keep: (name: string) => boolean): string[] {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean).map((p) => join(REPO, p))
    .filter((p) => keep(basename(p)) && existsSync(p));
}

const isScanned = (name: string) => TEXT.test(name) || ENV_FILE.test(name);
const repoPath = (file: string) => relative(REPO, file).replace(/\\/g, "/");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The retired passwords by length and SHA-256, so this file does not print them again.
 * Retired values only: an unsalted hash of a live short password could be brute-forced. */
const RETIRED = [
  { length: 13, sha256: "de35de7d0458947a713198bd3be53840680f05fe9d7085df2af07818dd66fdf3" },
  { length: 15, sha256: "9de154b4f90c3ca2a9f9f4357ccdb4256f4e9cb91f35c1966b15979ecc15a3a8" },
  { length: 17, sha256: "1daa6679d001655ba43088938d89b7cdd9b6a43c3f22d94d400ece8f5c0c3e26" },
];

/** Every token a password could be in text: split on spaces, quotes, brackets and the
 * punctuation that surrounds a value (`KEY=value`, `user:pw@host`, `?password=x&`, JSON
 * escapes), and tried again without a trailing full stop. A password itself may contain
 * `!`, so that is not a separator. */
const TOKEN = /[^\s`'"*(),;<>[\]{}|=:&?@/\\]+/g;

export function retiredIn(text: string): boolean {
  const lengths = new Set(RETIRED.map((r) => r.length));
  const hashes = new Set(RETIRED.map((r) => r.sha256));
  for (const raw of text.match(TOKEN) ?? []) {
    for (const token of [raw, raw.replace(/\.+$/, "")]) {
      if (lengths.has(token.length) && hashes.has(sha256(token))) return true;
    }
  }
  return false;
}

test("no retired password appears anywhere in the repo", () => {
  const found = committable(isScanned).filter((file) => retiredIn(readFileSync(file, "utf8"))).map(repoPath);
  assert.deepEqual(found, [], "a retired password is back in the repo: remove it (the repo is public)");
});

/** A password written into a file rather than read from the environment, in every shape
 * the retired ones were written in and the ones a careful person might reach for next. */
const LITERALS: RegExp[] = [
  // PASSWORD = "...", password: '...', pw = `...`; not an env var's name (`DEMO_PASSWORD`)
  // nor a translation key ("account.savedPassword"), which are names, not values.
  /\b\w*passw(?:or)?d\w*\s*[:=]\s*(["'`])(?!\1)(?![A-Z][A-Z0-9_]+\1)(?![a-z][A-Za-z0-9]*\.[A-Za-z0-9.]+\1)[^"'`\n]{4,}\1/gi,
  // A fallback to a literal: process.env.X_PASSWORD ?? "...", pw || '...'
  /\b\w*(?:passw(?:or)?d|pw|secret)\w*\b[^;\n]{0,80}(?:\?\?|\|\|)\s*(["'`])(?!\1)[^"'`\n]{4,}\1/gi,
  // Unquoted assignments: X_PASSWORD=value in shell, env files and docs; X_PASSWORD: value
  // in YAML (not a ${{ secrets.X }} reference).
  /\b[A-Z0-9_]*PASSWORD[A-Z0-9_]*=(?!\s|$|\$\{|\$[A-Z_]|<)[^\s'"`]{4,}/g,
  /\b[A-Z0-9_]*PASSWORD[A-Z0-9_]*:[ \t]+(?!\$\{\{|\$[A-Z_]|<)[^\s'"`#]{4,}[ \t]*(?:#.*)?$/gm,
  // SQL: create role x login password '...'
  /\bpassword\s+'[^'\n]{4,}'/gi,
  // A form body or query string: password=value
  /\bpassword=(?!\$\{|\$[A-Za-z_]|<|\.\.\.)[^&\s"'`]{4,}/gi,
  // A JSON body: "password": "value" (in scripts, docs and curl examples)
  /"\w*passw(?:or)?d\w*"\s*:\s*"[^"\n]{4,}"/gi,
  // SQL: pw text := '...', v_password text default '...'
  /\b(?:\w*pw|\w*passw(?:or)?d\w*)\s+text\s*(?::=|=|default)\s*'[^'\n]{4,}'/gi,
  // SQL: set demo.password to '...', set_config('demo.password', '...', ...)
  /\bpassw(?:or)?d\s+to\s+'[^'\n]{4,}'/gi,
  /set_config\(\s*'[^'\n]*passw[^'\n]*'\s*,\s*'[^'\n]{4,}'/gi,
  // A literal handed to crypt(): crypt('...'), crypt($$...$$)
  /\bcrypt\(\s*'[^'\n]{4,}'/gi,
  /\bcrypt\(\s*\$\$[^$\n]{4,}\$\$/gi,
  // Credentials in a URL: scheme://user:password@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:(?!\$\{)[^\s/@'"`]{4,}@/gi,
];

/** Each match's line in one file, for the failure message. */
export function literalPasswords(text: string): number[] {
  const lines: number[] = [];
  for (const pattern of LITERALS) {
    for (const match of text.matchAll(pattern)) lines.push(text.slice(0, match.index ?? 0).split("\n").length);
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

/**
 * Files allowed to hold a password-shaped literal, each for a reason that keeps it off
 * production: a local-only test database, a fake value a test feeds to a validator, or
 * this test's own samples. Anything else with a literal fails.
 */
const ALLOWED: Record<string, string> = {
  "src/lib/committed-passwords.test.ts": "the samples below exercise the patterns",
  "supabase/tests/shim/auth_shim.sql": "the local test database's own role; run.sh refuses any non-local host",
  ".github/workflows/ci.yml": "the throwaway Postgres container CI starts on localhost",
  "src/lib/push/subscription-validation.test.ts": "a fake user:pass@ URL the validator must reject",
};

test("no committed file holds a password of its own", () => {
  const found = committable(isScanned)
    .map((file) => ({ path: repoPath(file), lines: literalPasswords(readFileSync(file, "utf8")) }))
    .filter(({ path, lines }) => lines.length > 0 && !(path in ALLOWED) && !path.startsWith("src/lib/i18n/"))
    .map(({ path, lines }) => `${path}:${lines.join(",")}`);
  assert.deepEqual(found, [], "a password literal in a committed file: read it from .env.local instead");
});

test("the checks catch the shapes the retired passwords were written in, and the next ones", () => {
  const shapes = [
    'const PASSWORD = "Hunter2!x";',
    'body: JSON.stringify({ email: "a@b.test", password: "Hunter2!x" }),',
    "declare\n  pw text := 'Hunter2!x';",
    "crypt('Hunter2!x', gen_salt('bf'))",
    'const pw = process.env.DEMO_PASSWORD ?? "Hunter2!x";',
    "export DEMO_PASSWORD=Hunter2x",
    "curl -d 'email=a@b.test&password=Hunter2x' https://example.test",
    '{"email": "a@b.test", "password": "Hunter2!x"}',
    "v_password text default 'Hunter2!x';",
    "set demo.password to 'Hunter2!x';",
    "select set_config('demo.password', 'Hunter2!x', true);",
    "crypt($$Hunter2!x$$, gen_salt('bf'))",
    "postgres://admin:Hunter2x@db.example.test:5432/app",
    "      POSTGRES_PASSWORD: Hunter2x",
    "create role app login password 'Hunter2x';",
  ];
  for (const shape of shapes) assert.notDeepEqual(literalPasswords(shape), [], `missed: ${shape}`);
  // Reading one is fine, and so are placeholders and empty template lines.
  const fine = [
    'const PASSWORD = readEnv("CLICKTHROUGH_PASSWORD");',
    "pw text := nullif(current_setting('demo.password', true), '');",
    "crypt(p_password, gen_salt('bf'))",
    "DEMO_PASSWORD=",
    "set demo.password = '...';",
    "DATABASE_URL=postgres://user:${DB_PASSWORD}@host/db",
    'const ok = password === "";',
    "All passwords: `DEMO_PASSWORD` in `.env.local`.",
    "# DEMO_PASSWORD: every demo persona; the seed reads it as demo.password.",
    "      POSTGRES_PASSWORD: ${{ secrets.DB_PASSWORD }}",
    'password: "account.savedPassword",',
  ];
  for (const line of fine) assert.deepEqual(literalPasswords(line), [], `flagged: ${line}`);
});

test("a retired password is found however it is wrapped", () => {
  // A stand-in with a known hash cannot be used without printing a retired value, so this
  // checks the tokenizer on a fake: the same wrappings must yield the bare token.
  const fake = "Abc!defg-123";
  for (const wrapped of [`KEY=${fake}`, `u:${fake}@host`, `?password=${fake}&x=1`, `password:${fake}`, `--password=${fake}`, `"${fake}".`, `\\"${fake}\\"`]) {
    const tokens = (wrapped.match(TOKEN) ?? []).flatMap((t) => [t, t.replace(/\.+$/, "")]);
    assert.ok(tokens.includes(fake), `not split out of: ${wrapped}`);
  }
});
