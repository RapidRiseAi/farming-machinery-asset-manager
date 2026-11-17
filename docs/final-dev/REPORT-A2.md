# REPORT A2: billing changes and the subscription lifecycle

Saved by the main session from the worker's final message (the worker's harness refused to write this file, as for A1 and B1). Text unchanged apart from this line.

Task A2 is finished on `final/lane-a` (last commit `2bc170a`): 57 commits since `c75eed6`, nothing pushed, merged or applied to a database. Customers now pay for mid-period changes before they take effect, a failed renewal has a seven-day grace and then 90 days of owner-only access, cancellation runs to the paid-through date, and signup takes equipment with a quote route above 200 spaces.

**Checks (local only, no `.env.local`):** type check clean, 1162/1162 unit tests, all five lint checks clean, all 82 SQL suites pass on PGlite (292 migrations). I broke each new rule on purpose to check a test catches it: 35 breaks, all caught by an actual test failure. Real Postgres CI and a browser walk have not run.

**money-10 (`billing_review_5.sql`):** reproduced on 17 Nov. The test, not the code, was wrong. It moved a trial subscription 15 days back but set its anchor to the start day, which is the value fix 8 removed. So it passed only on days 1 to 15 of a month. The simulation now anchors on the day billing starts, as the function does. The 28-day assertion is unchanged, and a new assertion checks the anchor rule directly; re-breaking the function fails on any date. No engine change (`b033c69`).

**Decision for you before release:** the three migrations (`20261115110000`, `20261115120000`, `20261115130000`) must be applied and this build deployed straight away. Until it deploys, the live screens still call the old change functions, which raise capacity before payment.

## 1. Done

| Step | Commits | What it delivers |
|---|---|---|
| 1 and 2 Changes | `5481d42` to `70e8255`, `6cf26a5` to `d824238`, done in `de80a75` | **Migration `20261115110000`.** Every mid-period change becomes a stored quote with its basis, today's charge, any credit, renewal before and after, and an expiry (30 minutes or SA midnight, whichever is first).<br>**Accept:** the change is re-priced under a lock. If anything moved it is refused with `quote-changed`; an old price is refused with `quote-expired`.<br>**Takes effect now:** more spaces and higher plans apply only once the `change` invoice is paid, by a trigger on payments, so every way of paying works the same.<br>**Takes effect at renewal:** downgrades, reductions and term changes are scheduled; they can be cancelled or replaced.<br>**Credit:** a cheaper upgrade becomes credit in an append-only table, spent on the next invoice. Never a negative payment, never a refund.<br>**Screens:** the A1 conversion preview now shows the price; `/billing` shows the quote review and any changes still waiting. |
| 3 Cancellation | `45f33e5`, `434fc74` | Owners cancel at period end only; ending immediately is Rapid Rise only. The terms are rewritten and bumped to `TERMS_VERSION` 2026-11-15. |
| 4 Lifecycle | `cac1853` to `c4dfbe1`, `93df6d8`, `91e645b`, `73f753b` to `5bfa062`, done in `1933476` | **Migration `20261115120000`.**<br>**Grace:** from the day after the due date (or a card decline), for seven days. Records keep working, but nothing new that costs money: no charging quotes, paid AI and voice return `billing_paused`, WhatsApp is off.<br>**Day 8:** renewals and card retries stop. For 90 days only the owner can read, through tables, file storage and database functions. After that, nothing is readable until it is paid.<br>**Cancellation:** gives the same 90 days after the paid-through date and pauses the farm row, so scheduled engines stop.<br>**Dates:** all decided in South African time.<br>**Notices:** to the owner only, on the first day of grace and 30, 7 and 1 days before access ends.<br>**Screens:** `/suspended` and `/closed` give the owner-only download and a pay-to-reopen route; the export route refuses non-owners in words. |
| 5 Reactivation | in step 4, plus the existing restore-after-payment | Paying in grace, during the 90 days, or after them brings the account back once: a fresh period from the payment date, no new invoice. A reopened cancellation stays pending until paid, then the pause lifts. |
| 6 Payment integrity | `03187a1`, `5618d8c` | A succeeded payment attempt is final; a failure starts dunning only once; a late success is recorded. Money for a voided or no-longer-possible change becomes credit. Change invoices are never charged by the nightly run and never start dunning. Uniqueness: the AI-only invoice index already existed (since `20261010090000`), so I dropped my duplicate migration. |
| 7 Sign-up | `e1d81a6`, `d61f03d`, `1c3b927`, `dce1c35`, `c4b3434`, `c1be5a3` | **Migration `20261115130000`.** Signup takes an equipment quantity and 5 to 200 full spaces. 201+ is refused with `signup-capacity-quote` and saved as a quote request; Rapid Rise is notified and sees it on `/admin/billing`.<br>The `/signup` picker shows equipment and prices the total.<br>The live build's existing signup call still works. |
| Docs | `dc0d3a2`, `7b11f4b`, `0e087bd` | DATABASE.md, BILLING.md (new sections 16 and 17, plus notes where old sections are superseded), REQUIREMENTS.md rows. |

## 2. Scenarios and requirements

| Scenario | Where it is tested |
|---|---|
| 6 | `billing_change_quotes.sql` [6], `change.test.ts` |
| 7 | `billing_change_quotes.sql` [7], `change.test.ts` |
| 8 | `billing_change_quotes.sql` [8], `change.test.ts` |
| 10 | `billing_change_quotes.sql` [10], `billing_payment_integrity.sql` |
| 11 | `billing_lifecycle.sql`, `lifecycle.test.ts` |
| 12 | `billing_change_quotes.sql` [12], plus the existing `ai_usage_invoicing.sql`; the spending display is A3's |
| 40 | `billing_lifecycle.sql`, `pay_gate.sql` |
| 2 (signup half) | `billing_signup_capacity.sql` |

Requirement rows closed: R-009, R-029, R-083 (subscription kinds), R-090 to R-096, and the A2 parts of R-134 and R-141.

## 3. Not done

- **No browser run.** No `.env.local` here, so the new screens are type-checked, linted and unit-tested only.
- **No real Paystack call or real decline.**
- **No Paystack test/live `domain` check.** Paystack's docs refused automated fetching (403), so I didn't build on an unverified field.
- **No "mark handled" action** on quote requests; Rapid Rise answers them by email.
- **The old `billing_change_quota` / `billing_change_plan` functions are still there** for the live build. Nothing in this build calls them; drop them after the deploy.

## 4. Assumptions (flag any that are wrong)

1. "Stop further automatic renewals" also stops the weekly card retry from day 8.
2. Grace starts the day after the due date.
3. WhatsApp is fully paused in grace. A business's own OpenAI key keeps working in grace, but no AI runs during the 90 days.
4. Owner-only reading covers every stopped state, including Rapid Rise holds; contractors lose read access too.
5. An unpaid account stays `suspended` after its 90 days, so a late payment restores it the normal way.
6. Extra equipment spaces can't be given back early; retiring the equipment is how a customer pays less.
7. The 200 limit applies to in-app additions only when crossing it.
8. An amount under R1 left after credit is not charged.

## 5. Risks, most important first

1. **Staff of stopped businesses now read nothing.** This is intended, but expect support calls.
2. **Deploy order:** apply the three migrations and deploy at once.
3. **Closed cancellations now show `farms.status` as suspended** in admin screens.
4. **The gate now turns at South African midnight,** two hours earlier than the old UTC date between 22:00 and 24:00 UTC.
5. **No automatic payment recovery after day 8.**
6. **Pooled sites now follow plan changes** made on the main site.
7. **Two AI-only invoices raised at the same moment** hit the existing unique index and raise an error rather than skipping.
8. **Concurrency is proven by locks and unique indexes,** not by two live sessions.

## 6. External blockers

| Blocker | Smallest human action |
|---|---|
| Legal read | A lawyer reads the changed clauses in `src/lib/legal.ts` (changes, failed payment, cancelling, refunds, records) and the refund line in the cancel dialog. Open question: do CPA s14/s16 and ECTA s44 apply to these business customers? I make no legal claim. |
| Paystack `domain` field | Someone opens the Verify Transaction docs in a browser and confirms the field exists. |
| Real payment flow | A staging run with a test card: buy a space, decline, pay, upgrade with credit; then `ui:check` at 360 and 1024 px in English and Afrikaans. |
| Release | Apply the three migrations in order (probes are in `scripts/apply_pending.mjs`) and deploy immediately. |

## 7. Handover

- **A3:** call `app.farm_paid_extras_allowed` before any paid storage. `public.ai_reserve` and `ai_open_voice_session` now refuse with `billing_paused`; keep that check if you rewrite them.
- **A4:** use `retrieval_ends_on` and `public.farm_lifecycle` to know when the 90 days end. The 30/7/1-day reminders already exist. The export reads through the owner's session.
- **A5:** send `equipment` from the website signup. 201+ returns `signup-capacity-quote`; route it to `billing_request_capacity_quote`. Website copy must match the 2026-11-15 terms (no change-of-mind refund).
- **A6:** add the three migrations to the release sequence; drop the old change functions after the deploy.
- **B4:** `app.whatsapp_member` returns false during grace; keep that if you rewrite it.
