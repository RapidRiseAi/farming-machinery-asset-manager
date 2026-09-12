import { readdirSync } from "node:fs";
import { join } from "node:path";
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
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
