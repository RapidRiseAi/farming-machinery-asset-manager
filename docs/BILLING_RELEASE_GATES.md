# Billing, what is left to test and build

**As of 19 September 2026**, after the billing review of 18-19 September.

**Live state, measured rather than assumed:**

| | |
|---|---|
| Deployed commit | `0e54c7d` on `main` |
| CI | Run #291, green, 1m 34s |
| Vercel | Deployed and verified serving the new sign-up page |
| Migrations | `20260918120000`, `130000`, `140000` applied to production |
| Last billing cron | 19 Sep 04:01 UTC, **pre-deploy**, it does not yet carry the new step |

**How to read this.** Same rule the status checklist learned the hard way: if a line here
is wrong, it is wrong, not "awaiting its next audit". Check a claim before planning from
it. Every item below says what would settle it.

---

## A. Verify next, each needs one observation, not a build

**A1. Tomorrow's billing cron carries the renewal-notice step.**
The run at 04:01 UTC on 19 September fired before the deploy, so `steps` has no
`renewal_notices` key and `charges` is still in the old format without a page count. The
first run that should carry both is **20 September, ~04:01 UTC**.

```sql
select started_at, ok, steps ? 'renewal_notices' as has_new_step, steps->>'charges'
  from public.cron_runs
 where route = '/api/cron/billing'
 order by started_at desc limit 2;
```

Expect `has_new_step = true`, `renewal_notices` reporting `ok`, and `charges` now ending
with a `pages` count. It will legitimately send **zero** notices: no farm renews inside its
notice window yet. Zero is the pass. A missing key means the deploy did not take.

**A2. The first real sign-up through the new front door.**
The sign-up action now calls two functions that did not exist before this week, and it
fails **closed** on either. All three new functions were confirmed reachable over
PostgREST with the exact named arguments the code sends (`permission denied` for an anon
key, which proves existence plus lockdown, rather than `PGRST202`, which would prove
absence). The schema cache was reloaded. What has not happened is a real person completing
the flow.

**A3. The quota fix on a customer's own screen.**
`/billing` now estimates from `billedUnits()`. The demo farm is the proof case: quota 3,
zero machines, real invoice R750,00. Before the fix that screen said R0,00. Log in as that
farm and confirm it now reads R750,00 and that the vehicles card shows slots rather than a
counted fleet.

---

## B. Never exercised in production

These need a browser, a throwaway farm, or a real decline. None can be closed from code.

**B1. A real Paystack decline.** Test mode accepts every valid stored authorization, so
the only decline in the ledger is a hand-written row. Everything past the first failure -
the retry ladder at 3/7/14 days, grace, the downgrade, the failure email, has therefore
never run against a real event. This is the largest untested surface in the system.

**B2. `changeOwnPlan` and `changeVehicleSlots` actually pressed.** Both now show a priced
review first, so the old objection (one press charged a card with no figure shown) is gone.
They still write to a real ledger, and an upgrade raises a proration invoice that cannot
then be cleanly removed. Do this on a throwaway farm, not the demo.

**B3. The `/activate` settling states.** "Payment received" and "waiting on your bank" are
read from the ledger, so they are true however somebody arrives. Both are race-dependent
and neither has been seen live.

**B4. Resume after cancel, and card removal.** Both actions existed with no UI until this
week. Neither has been driven end to end.

**B5. The drained charge loop under real load.** Concurrency of six, a full-page `moreDue`
flag and the three loop bounds are proven in TypeScript tests. Production has never had
more than a handful of invoices due on one night.

**B6. The sign-up rate limiter under real traffic.** Proven in a rolled-back transaction on
production: three allowed, fourth refused, a second source unaffected. Never met a real
burst.

**B7. An invoice PDF carrying a real billing address.** Every invoice on production has a
null `bill_to_snapshot.billing_address`, because no farm has filled the fields in. The
snapshot is frozen at issue, so existing invoices stay blank for ever. `/billing` now
prompts for it. Fill it in on one farm and check the next invoice and receipt.

---

## C. Not built

**C1. The setup checklist has no navigation entry.** `/onboarding` is reachable only from
the dashboard and the billing page. A farm that closes it once will not find it again.

**C2. Receipts and failure notices cap at fifty a night each.** Both still take a single
bounded slice. Fine at current volume; the same silent ceiling the charge loop had before
it was taught to drain. `src/lib/billing/receipt.ts`, two `opts.limit ?? 50` call sites.

**C3. UI/UX work.** A separate, self-contained brief is at
[`prompts/billing-ui-ux-upgrade.md`](prompts/billing-ui-ux-upgrade.md). Summary: the
billing page buries its own answer below nine stacked cards, reading and changing are
tangled in the same cards, the invoice table is seven columns on a phone, the `Toast`
primitive is built and called by nothing, and the plan comparison shows one plan at a time
instead of comparing.

---

## D. Settings and environment, not code, and not reachable from a session

**D1. Leaked-password protection is off** in Supabase Auth. A dashboard toggle. Sign-up
currently enforces eight characters and nothing else, so this is free strength.

**D2. `SUPPORT_WEBHOOK_URL` is unset.** `support_delivery` has skipped every night for
weeks. Card disputes therefore never leave FleetWise, and their roughly 48 business hours
depend on somebody opening `/admin/support`. RapidRise OS is not in this workspace; the
contract is one POST per case, upsert on `id`, in `.env.example`.

**D3. Confirm `NEXT_PUBLIC_SITE_URL` in Vercel Production.** Every checkout callback is
built from it and it cannot be read from outside. Never presence-check it from a pulled env
file: `vercel pull` writes the literal string `[SENSITIVE]`, which is perfectly truthy.

**D4. Farm billing details.** See B7. Owner fills them at `/settings#set-billing`.

---

## E. Founder decisions

| Decision | Why it is blocking |
|---|---|
| `lapsed_grace_days` is live at **30** | It will close accounts. Needs a decision, not a default. |
| `src/lib/legal.ts` | Needs a lawyer's read, then bump `TERMS_VERSION`. |
| Part-refund for a period already supplied | Blocks the SaaS negative-payment model. The partner side already has one at `0422`. |
| The GitHub repository is **public** | Nothing secret is committed and push protection is on. Worth being deliberate rather than default. |

---

## F. Done, do not rebuild

Recorded so a later session does not redo work that is already live and proven.

- The quota/counted split on `/billing`, mirrored by `billedUnits()` and pinned by tests.
- Sign-up duplicate-email detection, now one indexed probe instead of a fifty-row page.
- Priced review before any plan or slot change, using the two quote functions that
  previously had no caller.
- Resume-after-cancel and card-removal UI.
- Per-outcome messages, shared by both billing screens, with `checking` never reported as
  success.
- `/activate` reading the ledger so a paying customer is not shown the pay button again.
- Renewal notices, 3 days monthly and 14 annual, priced from the live catalogue.
- Charge draining with bounded concurrency and a declared `maxDuration`.
- Sign-up rate limiting, plan comparison derived from the real entitlement gates, a
  quantified annual saving, and a vehicle stepper.

**Verification that already exists:** 166 migrations apply clean in order,
`billing_subscription.sql` passes, 294 TypeScript tests, typecheck, lint, i18n parity
across 4,304 keys in both languages, the key sweep, error coverage and design lint.
`pnpm db:test` still cannot run here (no psql); `pnpm db:check` stands in on PGlite with a
fresh database per suite. Four non-billing suites fail there on a stubbed `digest()` and
fail identically on a clean checkout, which is how they were attributed to the harness.
