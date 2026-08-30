# FleetWise — handover

> **Release update — 24 August 2026:** Voice Assistant release PR
> [#17](https://github.com/RapidRiseAi/farming-machinery-asset-manager/pull/17) is merged into
> `main`; application release commit `56373e869d4fb944bacb78868ee55ffc83965f2a` was
> deployed at `https://farming-machinery-asset-manager.vercel.app`. The six release migrations
> (scheduled reports, per-user permissions, public API/QR, POPIA coverage,
> selected-farm administration, and voice context/correction) were applied individually
> and verified on the hosted Supabase project. Production E2E passed deterministic EN/AF
> questions, machine clarification, the selected-farm reject path with no data mutation,
> the Azure Speech token broker, and the optional consent-gated Vercel AI Gateway path;
> consent withdrawal was also verified. Remaining Voice pilot work is physical-device
> microphone/audible-playback/offline QA, a separate Azure S0 pilot resource, the
> 200–500-utterance Afrikaans evaluation set, and processor/DPA sign-off. The historical
> drift warning below describes the earlier verification session and is superseded by this
> release update for the Voice Assistant schema.

Written at the end of the verification session and two business/financial waves
(migrations `0440`, `0450–0452`, `0460`, `0470–0476`, `0480–0483`, `0486`). Everything
described here is on `main` and pushed.

**Production is NOT currently identical to the repo.** All eleven financial migrations of
these two waves are applied and verified; a concurrent voice-assistant workstream landed in
the same commit and only part of its schema is live (see §5). Run the fingerprint before
assuming otherwise.

This document is deliberately blunt about what is **proven**, what is **built but
unexercised**, and what is **not built**. If a claim is not in the "proven" column, treat it
as unverified no matter how confident the code comments sound.

---

## 1. Where things stand

| | |
|---|---|
| Branch | `main` (all work merged and pushed) |
| Migrations in repo | 125 files, `0001` → `0510` plus the dated voice-assistant/POPIA/selected-farm files |
| Hosted demo project | `nmqtcvdwtyggxjjgtnzm` — financial schema verified applied; **known assistant drift, see §5** |
| Isolation suite | **four** files under `supabase/tests/` — `rls_isolation`, `public_api_and_qr`, `post_release_popia`, `selected_farm_administration` — **63 pass banners, green** |
| Gates | `pnpm db:test`, `typecheck`, `lint`, `build` all green; shared first-load JS flat at **102 kB** |
| i18n | EN/AF at parity, **3 445 leaf keys**, plus professional-tone overlays |

Demo logins are in `docs/FLEETWISE_MANUAL_SETUP_GUIDE.md`; every password is
`FleetWise!demo1`. The partner used for most testing is `tj@tjservice.example`; the farm
side is `danie@weltevrede.example` (owner) and `thabo@weltevrede.example` (operator).

---

## 2. The one thing to read before anything else

`pnpm db:test` builds a database **from** the migrations. It can only ever prove the repo
is sound. It says nothing about the live project, and that gap was not theoretical:

`public._f14_probe(uuid)` was created on production during F14 to answer "what does this
user see?", was never removed, and survived a whole session of green tests. It did **not**
bypass RLS — it was `SECURITY INVOKER` — but its body called
`set_config('request.jwt.claims', …)` with a uuid **the caller chose**, and every policy in
this schema decides through `auth.uid()`. So it did not switch the fence off; it moved the
caller to the other side and let RLS answer correctly on somebody else's behalf. A
Weltevrede operator with zero partner documents read back another tenant's counts.

Migration `0440` drops it. **`scripts/schema_fingerprint.sql` + `docs/SCHEMA_DRIFT.md` are
how it was found — run that comparison before trusting any statement that production matches
the repo.** Three normalisations in it were each earned the hard way (CRLF, psql client
encoding, stripped comments); read that doc before writing your own diff.

---

## 3. Proven — driven, measured, or asserted in the suite

Safe to build on.

* **Every RLS claim** in the isolation suite. Run `pnpm db:test`.
* **Repo and production are the same schema** — 981 objects, 10 categories, including
  **function grants**, which a body-only diff would miss.
* **The no-double-count rules**, each measured against the live database with real numbers:
  * a 25% stage invoice books 103 250 — its own value, not the quote's; a quote is never
    costed;
  * a stock issue naming a job card books nothing (the 0211 line owns it); an issue with no
    job card books its own `parts` entry; a receipt books nothing;
  * a credit note subtracts on the VAT return; a draft never appears there.
* **Idempotency**: a standing invoice pressed twice raised exactly one document
  (217 391 + 32 609 = 250 000 exactly); the low-stock engine run twice queued one round.
* **Letterhead freeze**: a **sent** document keeps the letterhead frozen at send time while
  a **draft** picks up a newly saved layout. Both PDFs generate.
* **Tenant isolation for the new surfaces**: a contractor with an *active link* to a farm
  reads 0 stock items and 0 movements; signing another partner's receipt returns 400 for
  another contractor, for the farm they work for, and for anon.
* **Role enforcement is in RLS, not the UI**: an operator may read the store and is refused
  a write at the database (42501).
* **Money and number formatting**: `rands()` identical in Node and Chrome across 22 cases.
* **VAT period arithmetic**: no gaps, no overlaps, correct category parity, real month-ends.
* **Cadence arithmetic**: the TS mirror agrees with `app.advance_by_cadence` on 12 cases
  including leap years.
* **All ten nightly cron engines** execute cleanly against the live database.
* **Bank reconciliation settles through the EXISTING rollup.** Confirming a matched line
  inserts a `partner_payments` row and nothing else; live, that moved `TJI-0001` from
  `part_paid` to `paid` (350 750 of 350 750), set a supplier expense's `paid_on` to the
  date money left, and booked zero cost entries. Re-importing an identical statement
  inserts 0 rows — including through `supabase-js` upsert against a GENERATED column,
  which was the one thing the agent could not test.
* **A purchase order books no cost.** `0473`/`0474` contain no code path to
  `cost_entries` or `partner_expenses`; G16 asserts it against a ledger snapshot taken
  before any order exists, and that converting produces exactly one expense while
  re-converting produces none.
* **The bank matcher is conservative in the right ways**: it skips fully-paid invoices,
  refuses a payment dated more than a week before its invoice existed, and never suggests
  a line larger than what is owed.
* **The money screen agrees with the VAT return.** `/money`'s revenue and
  `app.partner_vat_return` return the same figure over the same window — asserted in G14
  and confirmed live (R582,50 on both, from R1 032,50 of sales less R450,00 of credit
  notes). A written-off invoice stays in revenue and comes off as bad debt; non-claimable
  VAT counts as a cost; a written-off invoice is not chased on the debtors list.

---

## 4. Built but NOT exercised — verify these first

All of it compiles and has passing DB-level tests; none has been run against the real
external thing. **Every item here is blocked on a secret the founder holds**, which is why
it is still on this list.

1. ~~**Email has never sent.**~~ **Done.** The keys are set and a real statement was built,
   accepted by Resend and logged against the document (`document_emails`: `status=sent`,
   `provider=resend`, a provider id, `error=null`). Sent to an RFC 2606 reserved address so
   no live mailbox was touched. This unblocked scheduled reports (`0506`), which now ride
   the same path on the nightly cron.
2. **The PayFast ITN callback is untested.** It needs live or sandbox merchant credentials
   and a real payment. The three signing behaviours are proven (order preserved, PHP
   `urlencode` with `+` and uppercase hex, empty fields omitted); the round trip is not.
   Note: the signature has **not** been compared against PayFast's own published worked
   example — do that when you have the doc in front of you.
3. **The nightly cron HTTP route has never fired.** The ten engines it calls have all been
   run directly and are clean, but `/api/cron/nightly` needs `SUPABASE_SERVICE_ROLE_KEY` to
   construct its client and `CRON_SECRET` set in Vercel, plus the schedule confirmed
   (`docs/CRON.md`).
4. **The VAT return has not been checked against a real accountant's figures.** The
   arithmetic is asserted; the *interpretation* — what belongs in which box of a VAT201 —
   deserves one review by somebody who files them.

---

## 5. Known risks and things to double-check

* **The demo project now carries this session's test data**: one tracked stock item
  (HYD-68-20L, deliberately left below its reorder point so the low-stock badge demos), a
  captured expense with a receipt attached, a standing invoice, a 25% deposit invoice, and
  a handful of notifications. Useful for demos; worth knowing before reading any figure on
  it as "seed data".
* **`docs/FLEETWISE_MANUAL_SETUP_GUIDE.md` predates G6–G13** and does not mention the newer
  screens, env vars or demo data.
* **Dates still go through `toLocaleString`.** Money was the proven mismatch and is now
  hand-written; the same ICU-fallback risk applies to `shortDate` and friends. Currently
  only server-rendered, so no hydration break — but worth the same treatment.
* **Some `?error=` codes still render raw.** The receipt failures were given sentences; the
  older ones on the same screens (`need-supplier`, `need-amount`) still show their code.
* **A low-stock notification row is not a link** in the alert centre, although
  `notificationUrl` returns `/parts#store` for it. Cosmetic; the centre appears to link only
  some templates.
* **~~KNOWN SCHEMA DRIFT — the voice assistant.~~ CLOSED.** For a while only the four
  `users.ai_processing_*` columns were on production, applied under duress: `PROFILE_COLUMNS`
  selects them and `requireProfile()` gates every page, so without them EVERY role was
  bounced to `/login?error=no-profile` — a total outage caused by shipping code ahead of its
  schema. The rest (`voice_captures`, `ai_interactions`, `asset_aliases`,
  `app.assistant_turn_buckets`, their policies, the consent guard, the `record_*` commands
  and `apply_assistant_proposal`) is now applied too, so the assistant's schema is present
  and the repo is the only source of it.
  Two things were measured rather than assumed while applying it, because that migration
  rewrites `app.row_visible_to_role` and the core `machines_sel` policy: contractor and
  owner visibility were counted before and after and are **identical** (TJ 4 machines / 0
  costs / 3 own requests; owner 15 / 38 / 6), and the operator rule was exercised on a
  driver who actually has an assignment — **1 machine of 15, the assigned one**. Note that
  production carries **no `user_farm_memberships` rows**, so it is the migration's
  documented primary-farm fallback in `app.effective_farm_role` that answers, not a
  membership.
* **One expense per purchase order.** A supplier who part-ships and invoices twice can only
  link the first invoice to the order (partial unique index). Deliberate for now; noted by
  the agent that built it.

---

## 6. Not built at all

Three items that stood here in the previous revision have since shipped, and are recorded
so nobody rebuilds them: **purchase orders invoiced more than once** (`0501` — the
uniqueness moved to the supplier's own invoice number rather than being dropped),
**supplier statements and remittance advice** (`0502`, G25), and **commitment-aware
reordering** (`0503`, G26 — the lookahead is a farm setting, and the meter projection uses
the observed rate rather than the utilisation capacity, or every 250-hour service would be
"due within 30 days" for ever).

What genuinely remains:

* **Multi-currency.** Everything is ZAR, integer cents.
* **Payroll.**
* **A self-hosted licence SKU** (FR-19.4, P2).
* **WhatsApp Stage 2** (BSP API) — Stage 1 is manual; the queue and `deliver_after` are
  ready and waiting on an account.
* **Bank-feed import beyond `0470`** — statements are imported from CSV with column
  mapping; there is no live feed.
* **Named Sage/Xero export variants.** The accounting export (`0510`) ships in the two
  shapes every import wizard reads — separate debit/credit columns, and a single signed
  amount — deliberately named by shape rather than by vendor. Neither vendor's native
  column set could be established from a primary source: Xero Central renders through
  JavaScript and returns a shell, Sage's own import pages 404 and its documentation says
  only "download the template from inside the product", and the third-party importers that
  do publish a format **disagree with each other** while both calling it "the Xero format".
  Adding a named variant later is a formatting change that touches none of the arithmetic.

Excluded by decision rather than absence: **fuel-card import and GPS telematics**
(`SCOPE §13`, reaffirmed August 2026), and **customer-to-contractor payment processing**
(customers pay by EFT; invoices already carry the banking details).

---

## 7. Working on this project — things that will save you an hour

* **`pnpm db:test` recreates the test database**, applies every migration in order, then
  runs the isolation suite. Fastest way to know a migration is sound.
* **On Windows**: there is no `python`; use `node -e`. Export `PGCLIENTENCODING=UTF8` before
  loading migrations or the em-dashes in error messages become mojibake. Git Bash `PATH`
  entries must be POSIX (`/c/...`, not `C:/...`), and `MSYS_NO_PATHCONV=1` stops it
  mangling a `/route` argument into a Windows path.
* **A stale `.next` will lie to you**, and a server left running holds port 3000 while
  answering from the OLD build — which looks like a readiness check passing. Always: stop
  whatever holds 3000, `rm -rf .next`, rebuild, restart. `pkill -f "next-server"` is
  unreliable here; find the PID from the listening port and stop that.
* **Playwright**: `playwright-core` plus the Chrome already installed drives the app without
  a 150 MB browser download (`executablePath` to `chrome.exe`).
* **Discover selectors, do not guess them.** Several controls are `ConfirmDialog` *triggers*
  — clicking one opens a dialog and the real submit is inside it. Others look like buttons
  and are shortcuts that only prefill a field. Dump the page's controls first.
* **An enum value cannot be used in the transaction that adds it** — new values need their
  own migration file. Creating a brand-new enum type and using it is fine.
* **The freeze triggers refuse lines on an issued document**, correctly. Anything that
  builds an invoice must create it as a draft, add lines, then send.
* **Test against the live project inside `begin … rollback`** to verify behaviour without
  touching demo data.

---

## 8. Suggested order of work for the next session

Four items from the previous revision are done and are recorded here so nobody repeats them:
`0506`–`0510` are applied to the hosted project and verified against live data; the POPIA
erasure question was decided (erasure now scrubs `audit_log.ip` and `user_agent` — migration
`20260829130000`); the F16 contractor guard was made local to the eleven `_perm` policies
(`20260829130100`); and the schema fingerprint was run, finding and closing two real gaps.

1. **Run the schema fingerprint (§2) before trusting anything about production.** It has now
   earned itself three times: a debugging back door that existed only on the live database,
   `0501` applied in *pieces* (its indexes had landed, two of its functions had not), and
   `0510` missing entirely while code depending on it was already pushed. **Count objects,
   not migrations** — a ledger would have shown all three as done.
2. ~~Re-measure the shared first-load bundle.~~ **Measured — it is not this wave.** A/B on the
   same machine, same `node_modules`, `.next` cleared both times: `855930f` (before any of
   the wave-4 work) reads **103 kB**, and `99d8136` (everything, including the three agents
   and the voice assistant) reads **103 kB**. Identical, so nothing in wave 4 cost a byte of
   the shared bundle. The step up from the 102 kB held all project happened in the earlier
   91-file release. If the kilobyte is ever worth chasing, bisect between that release and
   `855930f` — not through wave 4.
3. **Finish the voice-assistant work** that was in flight during wave 4 and deliberately left
   uncommitted (`src/lib/assistant/**`, `src/components/assistant/**`, the assistant route,
   and an admin page). It typechecks now; it was mid-rename when wave 4 was committed around it.
4. Then pick from §6. Multi-currency is the largest. A named Sage or Xero export variant is
   the smallest and needs only one confirmed column set from inside either product — the
   research is recorded in §6 so it does not have to be repeated.
