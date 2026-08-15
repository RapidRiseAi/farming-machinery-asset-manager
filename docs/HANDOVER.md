# FleetWise — handover

Written at the end of the verification session and the first business/financial wave
(migrations `0440`, `0450–0452`, `0460`, `0470–0476`). Everything described here is on
`main` and pushed.

**Production is NOT currently identical to the repo.** The six financial migrations of this
wave are applied and verified; a concurrent voice-assistant workstream landed in the same
commit and only part of its schema is live (see §5). Run the fingerprint before assuming
otherwise.

This document is deliberately blunt about what is **proven**, what is **built but
unexercised**, and what is **not built**. If a claim is not in the "proven" column, treat it
as unverified no matter how confident the code comments sound.

---

## 1. Where things stand

| | |
|---|---|
| Branch | `main` (all work merged and pushed) |
| Migrations in repo | 109 files, `0001` → `0486` plus two dated voice-assistant files |
| Hosted demo project | `nmqtcvdwtyggxjjgtnzm` — financial schema verified applied; **known assistant drift, see §5** |
| Isolation suite | `supabase/tests/rls_isolation.sql`, 48 pass banners — **green** |
| Gates | `pnpm db:test`, `typecheck`, `lint`, `build` all green; shared first-load JS flat at **102 kB** |
| i18n | EN/AF at parity, **3 075 leaf keys**, plus professional-tone overlays |

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

1. **Email has never sent.** `RESEND_API_KEY` and `EMAIL_FROM` are unset, so every send path
   returns "email is not switched on". PDFs generate and every attempt is logged, but no
   message has left the system. Set the keys and send one document and one statement to a
   real inbox.
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
* **KNOWN SCHEMA DRIFT — the voice assistant.** Its two dated migrations are in the repo
  and pass `db:test`, but only the four `users.ai_processing_*` columns are on production.
  Those were applied because `PROFILE_COLUMNS` selects them and `requireProfile()` gates
  every page — without them EVERY role was bounced to `/login?error=no-profile`, a total
  outage caused by shipping code ahead of its schema. Still outstanding: `voice_captures`,
  `ai_interactions`, `asset_aliases`, their policies and the consent-guard trigger. Until
  those are applied the assistant will fail at runtime on the demo project. This is the
  clearest example yet of why §2 exists.
* **One expense per purchase order.** A supplier who part-ships and invoices twice can only
  link the first invoice to the order (partial unique index). Deliberate for now; noted by
  the agent that built it.

---

## 6. Not built at all

* **Purchase-order receipts against several invoices.** One expense per order (partial
  unique index), so a supplier who part-ships and invoices twice can only link the first.
* **Supplier statements and remittance advice.** Suppliers are records now (G18), so
  "what did I buy from this business this year" and a remittance to send with a payment
  are both a short step away.
* Multi-currency (everything is ZAR, integer cents).
* Payroll.
* WhatsApp Stage 2 (BSP API) — Stage 1 is manual; the queue and `deliver_after` are ready.
* **Commitment-aware reordering.** `app.stock_needs_reorder` is deliberately its own
  function so this is a one-place change. Today it is "at or below the minimum you set".
  `service_kit_items` already says what each service consumes and
  `app.recalc_machine_service` already knows what falls due, so "you have 2 filters and the
  250-hour service next week needs 6" needs no new tables — only a judgement about how far
  ahead to look, which is better made by somebody who has run a farm store.

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

1. Run the schema fingerprint (§2) before trusting anything about production.
2. Unblock §4 — all four items need only credentials, and email is the biggest gap against
   AutoVault.
3. Then pick from §6. Bank reconciliation is the one every partner does monthly; the
   commitment-aware reorder rule is the cheapest genuine improvement.
