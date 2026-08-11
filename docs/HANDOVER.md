# FleetWise — handover

Written at the end of the G6–G10 session (migrations `0430–0435`). Everything described
here is on `main` and pushed; the hosted demo project has every migration applied.

This document is deliberately blunt about what is **proven**, what is **built but
unexercised**, and what is **not built**. If a claim is not in the "proven" column, treat
it as unverified no matter how confident the code comments sound.

---

## 1. Where things stand

| | |
|---|---|
| Branch | `main` (all work merged; `claude/fleetwise-financial-controls` merged as PR #16) |
| Migrations in repo | 90 files, `0001` → `0435` |
| Hosted demo project | `nmqtcvdwtyggxjjgtnzm` — all 47 tables present, every feature migration applied |
| Isolation suite | `supabase/tests/rls_isolation.sql`, 5 592 lines, 35 sections, 505 assertions — **green** |
| Gates | `pnpm db:test`, `typecheck`, `lint`, `build` all green; shared first-load JS flat at **102 kB** |
| i18n | EN/AF at parity, **2 454 leaf keys**, plus professional-tone overlays |
| Routes | 50 pages, 18 API routes |

Demo logins are in `docs/FLEETWISE_MANUAL_SETUP_GUIDE.md`; every password is
`FleetWise!demo1`. The partner used for most testing is `tj@tjservice.example`.

---

## 2. What the product now does

The farm side (fleet registry, service, fuel, faults, job cards, checklists, compliance,
budgets, multi-site, POPIA) was complete before these sessions and is summarised in
`CLAUDE.md`. What follows is the **commercial/partner layer**, which is what recent work
has been about.

### The document spine (F14, G1–G5)

* Quotes, invoices, **credit notes**, **debit notes** — one table with a `kind`, not
  parallel schemas.
* Three recipient kinds: a linked FleetWise farm, a client from the partner's own book, or
  a **one-time customer typed straight onto the document**.
* **Editing an issued document in place**, with the previous version snapshotted into
  `partner_document_revisions` — the guarantee is "cannot change *without leaving a
  complete record*", not "cannot change".
* That history is **append-only**: grants revoked *and* a trigger that raises, `rr_admin`
  included. (Measured first: `DELETE` previously ran silently at 0 rows — default-deny, not
  an audit trail.)
* Four ways to correct a mistake: delete a draft, **void** with a reason, a **credit or
  debit note**, or **revise in place**. Plus **write-off** and **refund**.
* **Statements** with a real opening balance, ageing, PDF, CSV and email.
* Branded PDFs with the letterhead **frozen at send time**.

### G6–G10 (this session)

| Area | Migration | What it is |
|---|---|---|
| Purchases / expenses | `0430` | The input side. Workshop-scoped so a farm never sees its contractor's supplier invoices. |
| VAT return | `0431` | Output less input VAT, **invoice basis**, over real SARS periods (`workshops.vat_category`). Screen + CSV + PDF. |
| Deposits & progress billing | `0432` | Many invoices against one quote. No netting — each stage carries its own lines and its own cost entry. |
| Standing invoices | `0433` | Nightly cron raises them. Draft by default; **cannot bill the same period twice**. |
| Document layout | `0434` | A closed set of layout choices applied identically by screen and PDF, frozen into `issuer_snapshot`. |
| Online payment | `0435` | PayFast, env-gated. Unique index on `(provider, provider_ref)` stops a retried callback crediting twice. |

---

## 3. Proven — driven, measured, or asserted in the suite

These are safe to build on.

* **Every RLS claim** in the isolation suite (505 assertions). Run `pnpm db:test`.
* **The no-double-count rules**, each asserted with real numbers:
  * a job billed in stages puts exactly the job's value into the farm's ledger (G7);
  * a written-off invoice keeps its cost entry but leaves the ageing (G5);
  * a credit note subtracts from the VAT return, a draft never appears (G6);
  * a partner invoice, a work-request invoice and a job card never double-book (F12b, F14).
* **Tenant isolation for the new tables**: a farm reads 0 of its contractor's expenses; a
  contractor reads 0 of another contractor's; a partner cannot run or read another
  partner's schedules, VAT position or layout.
* **Idempotency**: re-running a standing invoice for the same period raises nothing; a
  duplicate payment reference is refused by unique index.
* **Money and number formatting**, verified on 18 cases and re-measured in the browser.
* **VAT period arithmetic** (category A/B/monthly) — no gaps, no overlaps, correct
  month-ends, checked over 8 periods.
* **Cadence arithmetic** — TS mirror checked against Postgres on 12 cases including leap
  years; a year of monthly runs from the 31st repeats no month.
* **PayFast signature** — matches PayFast's own documented worked example byte for byte,
  including the three details implementations get wrong (form order not alphabetical, PHP
  `urlencode` with `+` and uppercase hex, empty fields omitted).
* **Live browser sweep** of `/expenses`, `/vat`, `/recurring`, `/documents`, `/statements`,
  `/contractor/settings` on desktop and a Pixel-sized phone: no uncaught errors, no
  hydration failures, no horizontal overflow, no control under 48 px.
* **Dialog accessibility**: four dialogs on the invoice page focus a field (never the
  destructive button) and close on Escape.

---

## 4. Built but NOT exercised — verify these first

This is the honest list. All of it compiles, typechecks and has passing DB-level tests;
none of it has been run against the real external thing.

1. **Email has never sent.** `RESEND_API_KEY` and `EMAIL_FROM` are unset, so every send
   path returns "email is not switched on". The PDFs generate (verified, ~3 KB) and every
   attempt is logged, but no message has left the system. **Set the keys and send one
   document and one statement to a real inbox.**
2. **The PayFast ITN callback is untested.** It needs live (or sandbox) merchant
   credentials and a real payment through PayFast's servers. The signature is proven; the
   round trip is not. Use `PAYFAST_SANDBOX=1` first.
3. **The nightly cron has never fired in production.** `/api/cron/nightly` now calls ten
   engines including the new `cron_generate_recurring_invoices`. `CRON_SECRET` still needs
   setting in Vercel and the schedule wiring confirmed (`docs/CRON.md`).
4. **The new screens have not been driven end-to-end with writes.** They render correctly
   and the DB behaviour is proven separately, but nobody has: captured an expense through
   the form and watched it land on the VAT return; raised a stage invoice from a quote and
   sent it; created a schedule and let the cron raise it; saved a layout and downloaded the
   resulting PDF. **Do this first — it is the highest-value hour available.**
5. **The VAT return has not been checked against a real accountant's figures.** The
   arithmetic is asserted, but the *interpretation* (what belongs in which box of a VAT201)
   deserves one review by someone who files them.
6. **Receipts upload for expenses** — the bucket and policies exist (`partner-receipts`),
   and `receipt_path` is on the row, but **no upload UI was built**. The column is unused.

---

## 5. Known risks and things to double-check

* **Repo migrations ≠ production migration ledger.** The repo has 90 migration files; the
  hosted project lists 60 applied entries, because several were applied by pasting combined
  content rather than file-by-file. All 47 tables are confirmed present, but **column- and
  policy-level drift has not been exhaustively diffed.** A fresh project built from the
  repo is proven correct by `db:test`; the *hosted* one is proven only at table level.
  Worth a systematic comparison.
* **`docs/FLEETWISE_MANUAL_SETUP_GUIDE.md` predates G6–G10** and does not mention the new
  screens, env vars or demo data.
* **The demo seed has no G6–G10 data.** No expenses, no schedules, no staged invoices, so
  those screens open empty on the demo farm. Adding seed rows would make them demo-able.
* **`num()` and `rands()` were just rewritten.** They are used on nearly every screen.
  The unit cases pass and the live sweep was clean, but a wider visual pass across the farm
  side (dashboard, reports, machine detail, fuel) would be cheap insurance.
* **Dates still go through `toLocaleString`.** Money was the proven mismatch; the same
  ICU-fallback risk applies to `shortDate` and friends. Currently only server-rendered, so
  no hydration break — but worth the same treatment.
* **The nightly route isolates engine failures** — checked: `run()` records the error in
  `steps` and does not throw, so one failing engine does not stop the nine after it, and
  the route answers 500 with a per-engine breakdown. Nothing to fix; worth knowing when
  reading a failed run.

---

## 6. Not built at all

* Bank-feed import or reconciliation.
* Multi-currency (everything is ZAR, integer cents).
* Payroll.
* WhatsApp Stage 2 (BSP API) — Stage 1 is manual; the queue and `deliver_after` are ready.
* Purchase *orders* (the expense side records what was bought, not what was ordered).
* Inventory/stock levels (parts catalogue exists; quantities on hand do not).

---

## 7. Working on this project — things that will save you an hour

* **`pnpm db:test` recreates the test database** and runs every migration in order, then
  the isolation suite. It is the fastest way to know a migration is sound.
* **A stale `.next` will lie to you.** If the dev server is running while you rebuild, the
  browser gets old chunks against new HTML and you will see hydration errors that are not
  real. Always: kill the server, `rm -rf .next`, rebuild, restart.
* **`pkill -f "next start"` matches the invoking shell** and returns exit 144. Use
  `pkill -f "next-server"` and expect to re-run the next command.
* **Playwright** lives at `/opt/node22/lib/node_modules/playwright/index.js` and is
  CommonJS — `import pw from …; const { chromium } = pw;`. Chromium is at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
* **Vercel preview URLs are behind Vercel SSO** and cannot be driven by Playwright. Build
  and run locally against the live project instead (write `.env.local`, and **delete it
  afterwards**).
* **An enum value cannot be used in the transaction that adds it** — new values need their
  own migration file.
* **The freeze triggers refuse lines on an issued document**, correctly. Anything that
  builds an invoice must create it as a draft, add lines, then send.
* **Test against the live project inside `begin … rollback`** to verify behaviour without
  touching demo data. This works well and was used throughout.

---

## 8. Suggested order of work for the next session

1. Verify the claims in §3 independently — do not take this document's word for them.
2. Work through §4 in order; (4) is the highest value.
3. Diff the repo schema against the hosted project properly (§5, first bullet).
4. Seed demo data for the G6–G10 screens.
5. Then pick from §6 by what the business actually needs next.
