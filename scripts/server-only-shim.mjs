// Make the bare `server-only` marker resolvable in the TEST RUNNER, and nowhere else.
//
// ── Why a loader, and not a stub in node_modules ─────────────────────────────
// `server-only` exists to FAIL a build when server code reaches a client bundle, and this
// codebase keeps a Supabase service-role key, a Paystack secret and a Resend key behind
// exactly that line. Planting a stub in `node_modules/server-only` would disarm the guard
// for the real build as well — and it is not an installed package (Next resolves the
// specifier through its own bundler alias), so a stub is undeclared, unversioned, and
// wiped by the next `pnpm install`, which breaks the tests silently rather than loudly.
//
// Registering the substitution HERE keeps `import "server-only"` in the source where it
// belongs, and applies it only to the process that opts in — `scripts/test.mjs`.
//
// ── Why BOTH layers are patched ─────────────────────────────────────────────
// tsx transpiles TypeScript to CommonJS, so the ESM `resolve` hook never sees the
// specifier and only the `require` path does. Registering one and not the other looks like
// it works right up until the import actually happens.
//
// 24 modules under src/ carry the marker — every billing, email and PDF module of
// consequence. Without this, none of them can be unit-tested at all.
import { register, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./server-only-alias.mjs", import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const EMPTY_CJS = path.join(here, "server-only-empty.cjs");

const require_ = createRequire(import.meta.url);
const Module = require_("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only" || request === "client-only") return EMPTY_CJS;
  return originalResolve.call(this, request, ...rest);
};
