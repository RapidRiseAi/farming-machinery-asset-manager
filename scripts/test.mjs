import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Discover nested suites too; a fixed glob silently omitted the billing tests.
function tests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? tests(path) : /\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

const files = tests("src").sort();
if (!files.length) throw new Error("No tests found");

// `server-only` is a build-time marker Next resolves through its own bundler alias, so a
// plain node process cannot load ANY module that imports it — 24 of them under src/,
// including every billing, email and PDF module of consequence. The shim makes the marker
// resolvable in this process only; it is deliberately not a stub in node_modules, which
// would disarm the guard for the real build too. See scripts/server-only-shim.mjs.
const shim = pathToFileURL(join(import.meta.dirname, "server-only-shim.mjs")).href;

const result = spawnSync(
  process.execPath,
  ["--import", shim, "--import", "tsx", "--test", ...files],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
