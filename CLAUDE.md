# FarmGear, Farm Machinery & Vehicle Manager

Multi-tenant PWA for South African farms to manage machinery: registry, QR codes,
service scheduling, job cards, faults, costs, dashboards, WhatsApp alerts.
**Read [`docs/SCOPE.md`](docs/SCOPE.md) in full before planning any feature**, it is the source of truth.

## Stack
- **Next.js (App Router) PWA** + TypeScript + Tailwind, mobile-first (mid-range Android).
- **Supabase** (Postgres + Auth + Storage) with **row-level security** for multi-tenancy.
- Migrations = plain SQL files in `supabase/migrations/` (Supabase-compatible; also run against a local Postgres for tests).
- Deploy target: Vercel (app) + Supabase cloud. **Functions run in `cdg1` (Paris), beside
  the database in `eu-west-3` (Paris)**, set by `regions` in `vercel.json` (2026-10-10).
  They ran in Vercel's default `iad1` (Washington) until then, so every query crossed the
  Atlantic and a turn of the assistant spent seconds on round trips alone. Keep the two
  together: moving one without the other brings that back.

## Commands
```bash
pnpm install            # install deps
pnpm dev                # run app (needs .env.local, see .env.example)
pnpm build              # production build
pnpm typecheck          # tsc --noEmit
pnpm lint               # next lint
pnpm db:test            # apply migrations + run RLS isolation tests on local Postgres
pnpm db:check           # the same on PGlite when there is no psql; --suite runs them all
pnpm ui:check           # drive Chrome over CDP: do the screens' dialogs actually work?
pnpm voice:check        # hands-free voice mode end to end, with Azure stood in at the websocket
pnpm ready:check        # throttled phone: pages arrive marked as starting, hold taps, let go once they work
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
  the new member QR flow checks active farm membership for reads and inside capture transactions.
  Guests see only a Fleetwise login/signup/marketing gate. See `docs/DRIVER_ACTIVITY.md` for release status.
- **Auth:** email (password + magic-link) + email invites; the new QR workflow requires driver accounts.
  Phone/WhatsApp/SMS auth deferred (WhatsApp Stage 2).
- **i18n from day one:** all UI strings in `src/lib/i18n/en.json` (filled) + `af.json` (keys ready for
  the Week 3 Afrikaans pass). Minimal `t()` helper, no heavy i18n lib (bundle size).
- **A screen shows what IS; a button asks for what is NEW.** Capture forms live in dialogs,
  not on the page. Three choices, and there is no fourth: fields to fill in go in a
  `DialogForm` (with `DialogSection` for a long form's optional groups); the actions for one
  row go in an `ActionMenu`, titled with the row; more detail to READ goes in a
  `Disclosure`. Values are stated with `Fact`/`FactList` rather than rendered inside an
  input box. Do not add a new `<details>` or a hand-rolled dropdown; `pnpm ui:check` puts a
  ceiling on how many form controls a converted screen may show at rest.
- **Out of scope for v1** (Scope §13) is a hard NO: GPS/telemetry, anomaly ML, parts inventory,
  invoicing/accounting, crop/livestock/labour, store apps, full offline sync, >2 languages.
  Founder amendments supersede that original boundary: driver activity and staff-activated,
  separately quoted tracking integrations are approved in `docs/DRIVER_ACTIVITY.md`.

## Current state

**Phase: live in production on Vercel (`main`).** The app code in production is `240578d`
(2026-10-05): AI and voice usage release A (`f3ddce2`: every paid AI call and stretch of
voice held and settled into a per-farm, per-person ledger; owner limits; AI on by default
behind a notice; a farm's own OpenAI key called at OpenAI directly; failure detection;
`docs/AI_USAGE.md`), Codex's driver activity, member QR and quoted hardware activation
(`849725c`, `docs/DRIVER_ACTIVITY.md`), and release fixes (`240578d`: Enter on /login signs
in instead of sending a reset email; the driver migration's probe), on top of "buttons load
until they work" (`d9f701f`). Vercel Production reported Ready for that SHA and CI passed.
Against the live URL: `ready:check` passes on every page (taps held until React is attached,
/login included), `voice:check` 43/43 (Azure faked), `ui:check` passes (12 dialog screens
including /settings/ai; 55 routes at 360px and 1024px including /driver/activity),
`scripts/check_driver_http.mjs` passes, Enter on /login signs in, and the real speech-token
path behaves (no app version: 409 and no hold; the current app: a token with its voice
session; a zero final report settles it at R0, a second report gets 410). NOT exercised on
the live site: a real AI hearing or AI answer (Gateway credit), a farm linking its own key
(`AI_KEY_SECRET` unset), invoicing (release B), hands-free on a phone, driver activity that
writes (start, arrive, depart, finish) and member QR capture on a phone, and saving through
forms end to end.

**Schema and app are level.** All 191 migrations are applied to the live database; the
three of this release (`20261003142805`, `20261004095000`, `20261004100000`) went in on
2026-10-05 immediately before the push, and every probe answers true
(`node scripts/apply_pending.mjs --dry` reports nothing pending).
Billing is live and has taken a real payment; email sends via Resend.
`supabase/tests/deploy_compatibility.sql` pins every call shape the DEPLOYED build makes,
so a migration that drops a function signature is caught before it breaks the live site.
Run `node scripts/migrate_check.mjs --suite` (plain `db:check` does not run the SQL
suites) before applying anything ahead of a deploy.

**The product has been clicked through.** `node scripts/click_through.mjs` signs in as a
throwaway owner, walks twenty-two screens and writes through RLS. It needs the app running
(`npx next start -p 3111`) and a `.env.local`.

The full build history, ~55 session entries, oldest first, is in
[`docs/BUILD_LOG.md`](docs/BUILD_LOG.md). **Read it on demand, not by default**; grep it by
migration number (`0481`), commit (`bcbd39c`) or feature code (`F14`). Per-feature status
lives in [`docs/FLEETWISE_STATUS_CHECKLIST.md`](docs/FLEETWISE_STATUS_CHECKLIST.md).

### Open, founder only
- **AI help is on by default, metered, and invoiced since 2026-10-09** on each farm's own
  billing date (`20261010090000`, `20261011090000`; start date on `/admin/ai`;
  docs/AI_USAGE.md). Before real users join: sign the data agreements with Vercel, Microsoft
  and OpenAI (the basis is service necessity, so the transfer rests on them); set `AI_KEY_SECRET` (32 random bytes, base64, Sensitive) before any farm
  links a key, the SAME value on every deployment that shares the database (a Preview with
  its own refuses every farm's key); optionally `AI_ALERT_EMAIL`. The AI Gateway is on the
  free tier (5 requests a minute per model, $4.85 of free credit on 2026-10-05): add credits.
  Production's `LLM_MODEL` is `openai/gpt-5.4-mini`, which the free tier REFUSES ("Free tier
  users do not have access to this model"), so AI answers run on the fallback
  (`openai/gpt-4.1-mini`) until credit is added or `LLM_MODEL` names a free-tier model; an
  open `gateway_auth` event on /admin/ai says so. Vercel Hobby refuses
  zero-data-retention routing and is for non-commercial use; after an upgrade set
  `ASSISTANT_TRANSCRIBE_ZDR=1`. A rollback past `240578d` is not clean once people have
  seen the AI notice: roll forward (docs/AI_USAGE.md, "Releasing and rolling back").
- **Since `058ce7e` (2026-10-08) the assistant's AI reads the farm** (`src/lib/assistant/agent.ts`,
  docs/AI_USAGE.md "The assistant reads the farm"). Every question that reaches it first
  pays a refused `gpt-5.4-mini` call (about a second, R0) before the fallback answers: set
  `LLM_MODEL=openai/gpt-4.1-mini` until Gateway credit is added. The notice now names farm
  records, evidence `ai-on-default-v2` (`20261008090000` reset v1 acknowledgements): do not
  roll the code back past it, roll forward. The click-through farm holds labelled
  "Assistant eval" fuel, cost, fault and service rows for testing it.
- **WhatsApp** is Codex's, uncommitted in the main checkout (docs/WHATSAPP.md: a text pilot,
  not deployed, its migration local only). It reuses `runAssistantTurn`, so it gets the
  same agent. Its tree was synced onto `058ce7e` with its work intact (safety stash
  `codex-whatsapp-before-sync-2026-10-08`).
- **Production configuration still missing (read from Vercel on 2026-10-05):** `SENTRY_DSN`
  (no error monitoring: `captureError` only logs), `AI_KEY_SECRET`, `AI_ALERT_EMAIL`,
  `SUPPORT_WEBHOOK_URL` and `SUPPORT_WEBHOOK_SECRET`. Push and notification email need an
  external scheduler calling `/api/push/send` every minute with the cron bearer secret
  (docs/CRON.md): none is set up, so they go out only in the nightly pass (at most 25).
- **Drivers now need accounts** (Codex's release, `docs/DRIVER_ACTIVITY.md`): a QR scan by
  a guest shows a login gate, not anonymous capture. Invite anyone who used anonymous QR
  capture. Hardware tracking is a quoted, staff-activated service; no provider is connected.
- **The Azure Speech resource refuses parallel recognitions**, so two people talking at
  once collide (seen as "number of parallel requests exceeded"). Move it to S0.
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
- **Hands-free voice mode has never run on a real phone.** `pnpm voice:check` proves the
  loop in Chrome against a stand-in Azure. Whether iOS Safari plays the replies (the audio
  unlock) and returns sound to the speaker after the mic closes, and how well Azure really
  hears mixed Afrikaans and English, need a person on the live site.
- **The service worker stops pages hydrating after about eight hard loads in one tab.**
  The page renders correctly and React attaches to nothing: buttons visible, enabled,
  clicks do nothing, no console error, no error boundary. Reproduced on pages nobody had
  touched (`/machines/import`, `/statements`, `/settings/api`) and on `/tyres` at a third
  of the bundle size, so it is neither a regression nor bundle weight; bypassing `sw.js`
  makes the 9th and 10th loads hydrate fine. `ui:check` therefore bypasses the service
  worker. **Whether a real person on a real device can provoke it is not answered** -
  normal use is client-side routing, but this is a PWA relaunched from a home screen, and
  the symptom a customer reports is "the buttons don't work". Needs a phone.
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
  database the way the app does; the build only compiles a string. **`pnpm ui:check` is the
  fourth layer**: it drives real Chrome, so it can see what a harness that reads HTML
  cannot. Every capture form now lives behind a dialog, and a dialog is client state, so
  the trigger is all the HTML shows. It caught both bugs below. It now walks 53 routes at
  360px and 1024px, the full owner-reachable inventory.
- **A plain function re-exported from a `"use client"` module is a CLIENT REFERENCE**, not a
  function. A Server Component may render it or pass it as a prop; calling it throws
  "Attempted to call X() from the server". `tsc` and `next build` both pass, because the
  types are right. `menuItemClass` lives in `menu-item.ts` with no `"use client"` for this
  reason and must never be re-exported from `action-menu.tsx` again. The nasty part: the
  same bad import on `/incidents` passed every gate, because its one call sits behind
  `r.job_card_id` and the test farm's incident has no job card.
- **An enabled button is not a working button until the page has started.** The server
  renders every control looking ready and React attaches seconds later on a phone; a tap in
  between used to vanish. `src/components/ui/boot-guard.ts` puts `data-booting` on `<html>`
  before paint, which pulses every JS-dependent control and holds taps on the ones React has
  not attached yet, plus native submits of forms it does not own yet (GET forms and links go
  through); `<BootReady/>` takes it off once the document has fully arrived AND every control
  the server sent is attached (then a 4 s cap, 12 s overall, active time only), and the guard
  lets go by itself if React never starts. Browser checks wait for the mark to clear before
  tapping, and `pnpm ready:check` proves the whole thing on a throttled phone. A native
  control whose real behaviour is JavaScript (a select that acts in onChange, a link whose
  onClick must run) opts in with `data-needs-js`. A new kind of clickable control (a new
  `role`) goes into `BOOT_CONTROL_SELECTORS` AND its copy in `globals.css`; a test keeps the
  two equal.
- **`app.effective_farm_role(user, farm)` answers only for the signed-in caller.** It returns
  null unless `auth.uid()` is that user, and the service role may not execute it, so a
  server acting for someone, or an owner asking about an employee, always gets null. The AI
  ledger has its own `app.ai_member_role` for that reason; do the same rather than loosening it.
- **Any function that touches a billing table must be declared in `billing_subscription.sql`'s
  lockdown sweep** (`v_app_fns`), with the grants it checks: none to PUBLIC, anon or
  `authenticated`, none directly to the service role. The sweep finds undeclared ones by
  source text, which is how the AI ledger's reads of `billing_settings` were caught.
- **Never send a farm's own provider key through the AI Gateway's request-scoped BYOK.** The
  Gateway documents that a request whose own credentials fail "may still fall back to use
  system credentials" (and zero data retention skips such keys): the farm's use then runs on
  our account with no hold, no bill and no limit while the ledger says the farm paid. Call
  the provider directly with its own AI SDK package (`lib/ai-usage/openai-direct.ts`).
- **An Azure Speech token works on the whole Speech resource, so none is issued without a
  held voice session.** The speech-token route opens one per token; an app that never
  reports (an installed copy of an older build) is billed each token's whole session. A
  check-only gate ("may this farm have voice?") let any client that skipped the meter use
  Azure unmetered.
- **OpenAI answers an exhausted account with 429 `insufficient_quota`.** Classify quota
  (the error body's `type`/`code`) before rate limits, or a farm's dead key reads as a burst.
- **A dialog that saves and closes needs `DialogActions`.** Server actions here end in
  `redirect()`, which is a soft navigation: the client component keeps its state, so a
  hand-rolled dialog stays open over the row it just wrote. `DialogActions` watches
  `useFormStatus()` for the pending edge.
- **Save-and-restore of one global is a race as soon as there are two of anything.**
  `Overlay` snapshotted `document.body.style.overflow` per overlay; with a menu and a
  dialog open, the last restore won and left the page unscrollable. Count instead: first
  to open locks, last to close restores.
- **A phone can be too narrow WITHOUT anything overflowing.** When content cannot fit,
  Chrome widens the layout viewport to the content's minimum instead of scrolling, and
  the page renders zoomed out: no scrollbar, nothing to notice, just smaller text.
  `/reports/assets` sat at 442px because three money tiles shared a hard `grid-cols-3`
  and `rands` joins thousands with U+00A0, so "R1 500 000,00" is one unbreakable ~200px
  token. `ui:check` asserts BOTH `scrollWidth > innerWidth` and `innerWidth > 360`.
- **Check 1024px as well as 360px.** It is the narrowest width at which `lg:` applies, so
  it is where a layout only ever seen at 1280 shows its seams. A `<Table stacked>` is
  cards below `lg` and a real table above it, and shipping it without the scroll wrapper
  pushed `/team` to 1112px on a 13-inch laptop.
- **Speech cannot start from this machine, and `vercel env pull` will not fix it.**
  `AZURE_SPEECH_*` and `LLM_MODEL` are Vercel *Sensitive* variables: a pull writes
  `[SENSITIVE]`, which is where `.env.local`'s placeholders came from. Do not chase a local
  voice failure as a code bug. `pnpm voice:check` stands in for Azure; for REAL
  recognition, sign in as the click-through owner and take a token from the live
  `/api/assistant/speech-token`, and use a pulled development `VERCEL_OIDC_TOKEN` (12 hours)
  for the AI Gateway, from a scratch folder, never the repo.
- **A migration without a probe in `scripts/apply_pending.mjs` is skipped as "assumed
  applied".** The three job-card migrations had none, so the dry run said "Nothing pending"
  against a live database that had none of their objects, and the release would have shipped
  a build reading columns that did not exist. Every new migration gets a probe naming an
  object only it creates; confirm `--dry` lists it before applying or pushing.
- **A gate run on one English, near-empty fixture is a claim about that fixture.** `ui:check`
  passed all 53 routes at 360px while six pages rendered zoomed out for the demo personas:
  every Afrikaans page (the bell label "Kennisgewings" could not shrink), `/incidents` with
  real money values, and a contractor's DRAFT document. Long translations and real data are
  where width breaks; measure with an Afrikaans persona and a populated farm before calling a
  screen phone-safe.
- **A lint rule dies in one of two ways, and both happened to `kit-button` in one hour.**
  It matched the element and the class on ONE line, so it missed every real case (JSX puts
  `<Link` on 61 and its class on 63); then, broadened, it cried wolf at a brand-filled
  `<span>` badge. A rule over markup must walk to the element that owns the attribute, and
  needs a second discriminator (here, horizontal padding) to tell a button from a tile.
  Mutation-test every rule against the defect it exists for before shipping it.
- **A hand-picked route list in a gate is a coverage CLAIM, not coverage.** `ui:check`
  measured 28 routes at 360px against 82 `page.tsx` files, and the other 54 were not
  covered elsewhere, they were unmeasured, while "the gate is green" stood in for "the
  product fits a phone". Sweeping the rest found `/machines/[id]`, one of the most-used
  screens, rendering zoomed out on every phone. A gate's list is now the INVENTORY minus
  what the credential genuinely cannot open, and what is excluded is named with a reason.
- **To find what forces a too-wide layout, force the document narrow FIRST.** At the
  widened viewport nothing measures over-wide, because everything fits inside the width
  Chrome just granted; the first walk returned zero offenders and said the page was fine.
  Set `documentElement` and `body` to 360px, then walk for elements whose `right` exceeds
  it, leaves before branches.
- **A DETACHED element reports `scrollTop` 0**, and React tears a portal down before the
  effect's destroy runs. So the obvious cleanup, `write(key, el.scrollTop)`, faithfully
  stores 0 every time and the feature looks unimplemented with the code plainly in place.
  Read such a value synchronously in the listener, while the node is still in the
  document. Same family: focusing an element scrolls it into view, so a focus call that
  runs after a scroll restore silently undoes it (`preventScroll`), and a `sticky` child
  is bounded by the scroll container's PADDING box, so `py-2` on the scroller pins every
  heading 8px down. All three were found by instrumenting the browser, not by reading.
- **A client-side navigation preserves component state for free**, so a bug that only
  appears when the DOM is actually remounted cannot be reproduced by clicking around.
  Test the HARD load and the reopened portal too: the sidebar's scroll reset was
  `909 -> 0` on a full document load and `943 -> 0` on every single open of the mobile
  nav sheet, while three probes of ordinary clicking all reported it KEPT.
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
- **A date decided in SAST cannot be bounded by `current_date`.** `current_date` is the
  SERVER’s date and Supabase runs UTC, so between 00:00 and 02:00 SAST the two are
  different days. `apply_offline_capture` refused a reading taken at one in the morning as
  being in the future for exactly that reason. Bound a value against today in the SAME
  timezone it was decided in. A behavioural test for it passes at every hour and FAILS only
  during those two, so pair it with one that reads the rule rather than the clock.
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
- **A codemod that rewrites punctuation will rewrite a punctuation LITERAL used as data.**
  `dash_sweep.mjs --apply` turned the click-through's own em-dash detector from
  `html.includes("EM")` into `html.includes("-")`, which matches every page. The gate
  cannot see this: the dash is gone, so the file is clean. Build such a literal from its
  code point (`String.fromCharCode(0x2014)`) and read the sweep's non-comment diff before
  trusting it.
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
