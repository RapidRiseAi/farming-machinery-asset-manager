# FarmGear, Farm Machinery & Vehicle Manager

Multi-tenant PWA for South African farms to manage machinery: registry, QR codes,
service scheduling, job cards, faults, costs, dashboards, WhatsApp alerts.
**Read [`docs/SCOPE.md`](docs/SCOPE.md) in full before planning any feature**, it is the source of truth.

## Stack
- **Next.js (App Router) PWA** + TypeScript + Tailwind, mobile-first (mid-range Android).
- **Supabase** (Postgres + Auth + Storage) with **row-level security** for multi-tenancy.
- Migrations = plain SQL files in `supabase/migrations/` (Supabase-compatible; also run against a local Postgres for tests).
- Deploy target: Vercel (app) + Supabase cloud. (Not wired in Week 1.)

## Commands
```bash
pnpm install            # install deps
pnpm dev                # run app (needs .env.local, see .env.example)
pnpm build              # production build
pnpm typecheck          # tsc --noEmit
pnpm lint               # next lint
pnpm db:test            # apply migrations + run RLS isolation tests on local Postgres
pnpm db:check           # the same on PGlite when there is no psql; --suite runs them all
```
`pnpm db:test` runs `supabase/tests/run.sh`: it (re)creates a local test DB, loads the
Supabase auth shim, applies every migration in order, then runs the RLS isolation suite.

## Key conventions & decisions
- **Tenancy first.** Every business table carries `farm_id` (denormalized, enforced by composite FKs).
  RLS is the *sole* guarantor of cross-tenant + external-workshop isolation and is proven by tests
  (`supabase/tests/rls_isolation.sql`) before any feature is built on top.
- **RLS model:** app role/farm live in `public.users` (PK = `auth.users.id`). Helper fns in schema `app`
  (`is_rr_admin()`, `accessible_farm_ids()`, `has_farm_access(farm_id)`) drive every policy.
  Workshop staff reach farms via `workshop_links` (status=active). RR admin = cross-tenant (logged).
- **Money** stored as **integer cents, ex-VAT**; `vat_rate` captured. No floats near money.
- **History is structural:** soft delete (`deleted_at`/`deleted_by`), append-only `audit_log` (trigger),
  job cards lock after approval (trigger blocks edits; history via audit diffs).
- **Public QR flow has ZERO anon DB access.** QR encodes an unguessable per-machine `public_token`;
  submissions go through service-role server routes that validate the token.
- **Auth (v1):** email (password + magic-link) + email invites; workers use the no-login QR page.
  Phone/WhatsApp/SMS auth deferred (WhatsApp Stage 2).
- **i18n from day one:** all UI strings in `src/lib/i18n/en.json` (filled) + `af.json` (keys ready for
  the Week 3 Afrikaans pass). Minimal `t()` helper, no heavy i18n lib (bundle size).
- **Out of scope for v1** (Scope §13) is a hard NO: GPS/telemetry, anomaly ML, parts inventory,
  invoicing/accounting, crop/livestock/labour, store apps, full offline sync, >2 languages.

## Current state

**Phase: v1 complete and live in production on Vercel (`main`).** `main` is **pushed and
level with `origin/main`** at `0ec5ec7`, which carried thirty commits: the billing and
sign-up UI work of 19/09/2026, the diesel, offline and email work of 20/09/2026, and on
21/09/2026 Founding Farmer pricing, eight gap-review features, the login-screen fixes and
the em-dash sweep. Verified before pushing on a PRISTINE worktree installed from the
lockfile, which is what Vercel builds: typecheck, lint, 390 tests, build, i18n parity,
key sweep, error coverage, design lint. Billing is live and has taken a real payment.
Email sends and is confirmed `delivered` by Resend.

**Schema and app are level again.** Every migration in this repo is applied to the live
database (`node scripts/apply_pending.mjs --dry` says so), and the code that uses them is
deployed. They came apart for a few hours on 21/09/2026 while the migrations were applied
ahead of the push, which is the window `supabase/tests/deploy_compatibility.sql` exists
for: it pins every call shape the DEPLOYED build makes, so a migration that drops a
function signature is caught before it breaks the live site. Run it before applying
anything ahead of a deploy again.

**The product has been clicked through.** `node scripts/click_through.mjs` signs in as a
throwaway owner, walks twenty-two screens and writes through RLS. It needs the app running
(`npx next start -p 3111`) and a `.env.local`.

The full build history, ~55 session entries, oldest first, is in
[`docs/BUILD_LOG.md`](docs/BUILD_LOG.md). **Read it on demand, not by default**; grep it by
migration number (`0481`), commit (`bcbd39c`) or feature code (`F14`). Per-feature status
lives in [`docs/FLEETWISE_STATUS_CHECKLIST.md`](docs/FLEETWISE_STATUS_CHECKLIST.md).

### Open, founder only
- **`lapsed_grace_days` is live at 30 and it will close accounts.** Needs a decision, not a default.
- **`src/lib/legal.ts` needs a lawyer's read**, then bump `TERMS_VERSION`.
- **Confirm `NEXT_PUBLIC_SITE_URL` is set in Vercel Production.** Every checkout callback is
  built from it and it cannot be read from outside. (`RESEND_API_KEY`/`EMAIL_FROM` are
  confirmed set, email has sent.)
- **Decide what a part-refund means for a period already supplied.** This blocks the SaaS
  negative-payment model; the partner side already has one at `0422`.
- **`SCOPE.md` §13 no longer matches the product.** Parts and accounting shipped, and store
  apps plus offline sync are now requested. Record the real boundary before building
  `docs/NATIVE_APP_AND_OFFLINE_PLAN.md` or the gaps in
  `docs/FEATURE_GAP_REVIEW_2026-09-19.md`.

### Open, needs a browser or a throwaway farm
- A real Paystack **decline** has never happened (test mode accepts every valid stored authorization).
- `changeOwnPlan` / `changeVehicleSlots` are rendered and verified wired but **never
  pressed**, they write to the demo farm's ledger, and an upgrade raises a proration
  invoice that cannot then be cleanly removed. Their arithmetic is proven in SQL inside
  rolled-back transactions. Both now go through a priced review step first, so the number
  is on screen before anything commits.
- **A throwaway farm sits on the live database.** `f0000000-...-fa01`, "Click-through Test
  Farm", with an owner, two machines and a job card, created by `scripts/seed_test_farm.mjs`
  so the screens could be walked. `node scripts/seed_test_farm.mjs --remove` deletes exactly
  what it made, by id.
- **`billing_promo_codes` ships empty and no Founding Farmer code exists.** The engine can
  give the rate `SCOPE.md` §12 promises; how many places and at what rate is a decision
  nobody has made. Inventing one would be inventing a price.

### By design, not gaps
- A refund or dispute **opens a support case and moves nothing in the ledger.** Money goes
  back only when a person decides, case by case (`docs/BILLING.md` §11b). A mid-cycle
  downgrade and a cancellation are not refunds and already work unaided.
- **RapidRise OS is not in this workspace**, so the support-case receiver is not built. The
  contract is in `.env.example`: one POST per case, upsert on `id`.
- **Paystack has no collections cap for this account.** Rapid Rise AI is a Registered
  Business, approved, live, ZAR payouts to a Capitec Business account. Every cap figure in
  the build log (R80 000, ZAR 1 000 000) is wrong for this account.

## Hard-won rules

Each of these cost a debugging session. They are here rather than in the log because they
will bite again.

**Verification**
- **Count objects, not migrations** (`docs/SCHEMA_DRIFT.md`), and inventory the *calling*
  side too. Check every `.rpc("…")` name in the app against `pg_proc` on the live database.
- **A screen and the engine can disagree about the same number.** `/billing` estimated from
  the COUNTED fleet while the generator billed `coalesce(asset_quota, counted)`, and quoted
  a production farm R0,00 against a real R750,00 invoice. When a figure exists in SQL and in
  TypeScript, the TS one mirrors the SQL by name (`billedUnits` ↔ `billing_billable_units`)
  and a test pins them together. Check the *arithmetic inputs*, not just the formula.
- **A paged API default is a bug that waits for growth.** `listUsers()` returns fifty rows;
  the sign-up duplicate check would have begun turning real customers away at the 51st user
  and never failed a test. Any list call without an explicit page size is a latent ceiling.
- **A suite that fails early HIDES every assertion after it.** `atomic_offline_capture.sql`
  fails on PGlite on the stubbed `digest()`, so `db:check` reported that and nothing else,
  while four validations dropped from the offline reading path sat unasserted behind it
  until CI ran the suite on real Postgres. When a suite is known-red locally, the
  assertions past the failure point are NOT covered: give them a suite that runs.
- **`pnpm db:check`** applies every migration and suite to PGlite (fresh database per suite)
  when there is no psql. Four non-billing suites fail there on a stubbed `digest()`, run it
  on a clean checkout before blaming your change for a failure.
- **Three test layers all miss reachability.** The TS tests mock the Supabase client, so they
  assert *arguments* and never whether a function exists; `db:test` does not call the
  database the way the app does; the build only compiles a string.
- **The mutation harness reports false survivors**, it reads migrations from the repo, not
  the copy you just edited. This has happened three times. Confirm a mutation changed what
  actually ran.
- **Prove it by running it**, against production inside a rolled-back transaction, rather
  than asserting it from the code.
- **Headless Chrome on Windows will not lay a window out narrower than ~500px.** A "360px"
  measurement taken with `--window-size=360,…` is really 504px. Render inside a fixed-width
  `srcdoc` iframe and read the frame's own `innerWidth`.
- **Render the component and measure it; do not reason about it.** The appearance switch
  changed width by 54px in English and 56px in Afrikaans every time it was pressed, and the
  fix was only provable by rendering old and new markup side by side in a 360px iframe with
  the BUILT css. Rebuild first: a stale `.next/static/css` bundle lacks any Tailwind class
  your change just introduced, and the measurement silently reports the unstyled layout.
- **React strips `name` from a submit button that has a function `formAction`.** It encodes
  the action into that attribute itself and warns "It will get overridden". Any scheme that
  identifies a button by its posted name therefore fails on exactly those buttons, silently.
  Use `useFormStatus().action` for them instead. Found by reading the rendered DOM, not the
  source.
- **CI job logs need repository admin rights.** `git credential fill` supplies the token git
  already uses for pushes, that is how a week of red CI was finally read.

**Postgres and Supabase**
- **PostgREST exposes `public` ONLY.** Every function in schema `app` is unreachable via
  `supabase.rpc()` and resolves to nothing. Public wrappers are required, and suite section
  **(m)** asserts function names *and parameter names*, PostgREST resolves overloads by
  named arguments, so a renamed parameter breaks the call as completely as a deletion.
- **A policy governs what you ask BACK, not only what you write.** `select *` on `machines`
  is `permission denied` for `authenticated`, the cost columns are withheld at the COLUMN
  level (`20260903074350`), so a test or a page that reads `*` fails even where a targeted
  read succeeds. Same family: `.update({deleted_at}).select()` on a soft delete asks
  PostgREST to return the one row the SELECT policy has just been told to hide, so it
  reports zero rows and the action says "not found" about a write that worked. Check
  existence before the write, or do not ask for the row back.
- **`create function` grants EXECUTE to PUBLIC, and `anon` inherits it.** A `grant ... to
  authenticated` does not replace that; every `app.*` helper needs an explicit
  `revoke execute ... from public, anon`. Eight shipped without one on 21/09/2026 and only
  CI caught them: the G11 sweep lives in `rls_isolation.sql`, which runs on real Postgres
  only, so every local gate was green. The same assertion is now in
  `deploy_compatibility.sql`, which `pnpm db:check` runs.
- **An enum value cannot be added and used in one transaction.** Postgres answers "unsafe
  use of new value", and the migration runner applies one file per transaction. The value
  goes in a file of its own and the code that uses it in the next one (`20260921140000` and
  `141000`).
- **Check the DEPLOYED app before applying a migration that drops a function signature.**
  Vercel serves `origin/main`, which is behind this repo, and PostgREST resolves by
  argument NAME: dropping a signature the live build calls breaks that call for every
  customer until the next deploy. `supabase/tests/deploy_compatibility.sql` pins those call
  shapes, and a defaulted new parameter is what keeps an older call working.
- **A `language sql` function is parsed at CREATE**, so a helper must appear before its
  caller in the same migration file. `check_function_bodies` is on; the failure is at
  `db:check` time and reads like a typo.
- **`min()`/`max()` on text sort by the database's collation.** `C` yields `Agri Diesel`,
  `en_US.UTF-8` yields `agri diesel`. Production and CI are `en_US.UTF-8`. Run the suites
  under both; "deterministic pick" in a comment is not one.

**Environment and deploys**
- **`vercel pull` cannot decrypt secrets**, it writes the literal string `[SENSITIVE]`,
  which is perfectly truthy. Never presence-check a secret from a pulled env file. That bug
  reported email as configured for weeks while Resend rejected every call.
- **The branch must build on a CLEAN CHECKOUT**, which is what Vercel builds. `pnpm
  typecheck` passing in a working tree that holds another workstream's uncommitted files
  proves nothing.
- **Windows checks files out CRLF**, and that changes migration hashes. Strip CRs before
  comparing against production.
- **A test uuid must be hex.** `m`, `w`, `j` and the rest are not, and Postgres answers
  "invalid input syntax for type uuid", which reads like the row is wrong rather than the
  literal. This has cost three debugging rounds; pick prefixes from `abcdef0-9`.
- **Never commit a credential-shaped literal**, even a deliberately fake one in a test -
  GitHub push protection blocks the push. Assemble it by concatenation; same runtime value,
  no secret-shaped string in the source.

**Judgement**
- **For anything that lives in someone else's dashboard, check the dashboard.** A note
  records what was true when it was written; a published pricing page describes the default
  tier, not this account. This was wrong twice about the Paystack cap.
- **Never present a fallback as an identification.** The dispute path reports `source` as
  `charged` only when that attempt genuinely used the card, `farm_default` otherwise -
  because the case may end with a person being told their card was used without permission.
- **A checker that cries wolf stops being read.** The first `i18n:keys` gate flagged nine
  legitimate call sites; that gets fixed before the gate ships.
- **Runtime-built keys evade static sweeps.** `PageInfoButton` composes its key at runtime
  from an `infoKey` prop, so three pages rendered raw keys to users while parity passed.
  `pnpm i18n:keys` now covers static keys, dynamic stems and page-info keys. **`enumLabel`
  is worse**: on a miss it prints the raw enum value, which looks plausible. The four
  billing status groups never existed and both screens showed Postgres enums from day one. A
  new group needs a test that walks its values in both languages (`view.test.ts`).
- **Do not patch another session's in-flight files.** Adding a key for someone else's
  unfinished feature is how fragments collide.
- **Do not rewrite a superseded log entry.** Add a line that supersedes it, editing hides
  that it was ever wrong.

## Where things are written down

`docs/` is the long-form record. The ones worth knowing by name:

| Need | Read |
|---|---|
| What the product must do (**source of truth**) | `SCOPE.md` |
| How it was built, session by session | `BUILD_LOG.md` |
| Per-feature status | `FLEETWISE_STATUS_CHECKLIST.md` |
| Billing, plans, refund policy (§11b) | `BILLING.md` |
| Paystack go-live steps | `PAYSTACK_GO_LIVE.md` |
| Repo-vs-production schema truth | `SCHEMA_DRIFT.md` |
| Security posture and POPIA | `SECURITY.md`, `POPIA.md` |
| Decisions already taken | `FLEETWISE_FOUNDER_DECISIONS.md` |
| Onboarding another person | `HANDOVER.md` |
| Scheduled jobs | `CRON.md` |

## Session-end protocol

At the end of a working session, **append one entry to
[`docs/BUILD_LOG.md`](docs/BUILD_LOG.md)**, not to this file. Keep the existing entry
shape: what was *measured*, migrations applied, gates run, and explicitly what was left
undone and why.

Then update **this** file only where it has become wrong:
- the commit and CI line under **Current state**, if they moved;
- an item under **Open**, if it opened or closed;
- a rule under **Hard-won rules**, if the session learned one that will bite again.

Most sessions should change one to three lines here. **If this file grows every session,
the content belonged in the build log.**
