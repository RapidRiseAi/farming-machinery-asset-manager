# FleetWise SaaS billing

How farms pay Rapid Rise for FleetWise. Written for the person who has to understand this
at three in the morning, not for a feature list.

For the manual setup steps, see [`PAYSTACK_GO_LIVE.md`](PAYSTACK_GO_LIVE.md).

---

## 1. The scope boundary

This is **farms paying Rapid Rise for software**. One direction, one relationship.

It is **not** the money that moves between a farm and its contractors, workshops or
suppliers. That is `partner_documents` / `partner_payments` (F14, G1–G10), and FleetWise
deliberately does not sit in the middle of it — customers pay contractors by EFT outside
the product, and the dormant PayFast seam in `src/lib/payments/*` stays inert.

The two ledgers never meet:

- Every table here is prefixed `billing_`, so they cannot be confused in a query, a backup
  or a stack trace.
- No billing function references a partner table. Asserted in
  `supabase/tests/billing_subscription.sql` §(k) against `pg_proc.prosrc`, not by hoping.
- No Paystack transfer, split, subaccount or payout is used anywhere. FleetWise never
  routes money between third parties, which is a regulatory position as much as a
  technical one.

If a later reader finds themselves joining `billing_invoices` to `partner_documents`, the
design has gone wrong.

## 2. Where subscription state lives

**Here, in Postgres. Not at Paystack.**

Paystack moves money and nothing else: it holds no plan, no price, no period and no
entitlement. This is not preference. The amount changes with each farm's active vehicle
count, so a fixed provider-side "Plan" object would be wrong the moment a farmer sells a
tractor. We compute the amount, we raise the invoice, and we ask Paystack to charge a
stored card authorization for exactly that.

## 3. The two plans — read this twice

| Column | Meaning |
|---|---|
| `farms.plan` | The **EFFECTIVE** plan. What `app.has_entitlement` and every gated route resolve from. |
| `billing_subscriptions.plan` | The **COMMERCIAL** plan. What the farm actually bought and is billed for. |

They are normally identical. They diverge in exactly one situation: a farm that has not
paid past its grace period is downgraded by writing a lower value into `farms.plan`, while
`billing_subscriptions.plan` keeps the plan they bought and
`billing_subscriptions.plan_before_downgrade` records what `farms.plan` held.

Two things follow, and both matter:

- **The downgrade needed no new entitlement code at all.** Every gated surface, the SQL
  helper and the TS map keep working unchanged, because the thing they read is the thing
  that moved.
- **Nothing is ever deleted for non-payment.** The vehicles, job cards, invoices, fuel
  records and history are untouched; the gates close and reopen. One successful payment
  runs `app.billing_restore_after_payment` and puts `farms.plan` back exactly.

A later reader will be tempted to "simplify" by collapsing the two columns. Don't. That is
the same as losing the record of what the customer is owed on recovery, and it is asserted
against in §(l).

## 4. VAT — the position today

**Rapid Rise is not registered for VAT** (founder decision #8).

`billing_settings.vat_registered` is `false`, and a trigger
(`app.billing_force_vat_rate`) forces every invoice to a 0% rate with a null seller VAT
number. It overrules the caller, so a stale form, an import or a bug cannot issue VAT we
cannot legally collect. The UI shows no VAT line, and an invoice is correctly **not**
headed "Tax invoice" — VAT Act s20(4) reserves that for a registered vendor.

The full machinery is built anyway. Registering later is a flag flip plus a VAT number,
and it **restates no historical invoice**: every invoice snapshots its own rate at issue,
and §(h2) asserts that flipping the flag leaves earlier invoices at 0%.

This deliberately mirrors the partner-side guard already proven in migration `0401`, so
this codebase has one idea about "an issuer who may not charge VAT", not two.

> The guard is not covered by the VAT *arithmetic* tests, which feed it a rate. It has its
> own section, §(h3), added after a mutation that disabled the guard survived the suite.

## 5. Prices

`billing_price_versions` holds a **versioned** price list: one row per (version, plan,
billing period), priced per vehicle per month, **VAT-inclusive**, in integer cents.

**RESOLVED 2026-09-04.** The founder confirmed the founder document, and migration
`20260904120000` seeded the `launch-2026` generation:

| Plan | Per vehicle / month (VAT-incl) | Annual (10 months) |
|---|---|---|
| Essential | R44,00 | R440,00 |
| Professional | R73,00 | R730,00 |
| Complete | R89,00 | R890,00 |
| Done-For-You | R250,00 | R2 500,00 |

`src/lib/entitlements.ts` carries the same figures, and a test reads the migration itself
to prove the quoted price and the invoiced price agree. **Seeding a price releases only the
FIRST lock** — invoices can now be raised, and with `BILLING_CHARGING_ENABLED` unset nothing
can be charged. The conflict this replaced was:

| Source | Essential | Professional | Complete | Done-For-You |
|---|---|---|---|---|
| `FLEETWISE_FOUNDER_DECISIONS.md` #1 | R44 | R73 | R89 | R250 |
| shipped `src/lib/entitlements.ts` | R39 | R69 | R99 | POA |

Both claimed to be VAT-inclusive, so only the numbers were in dispute — which is why the
catalogue shipped EMPTY rather than guessing: with no `active` price version
`app.generate_billing_invoices` raises nothing, and there is nothing to charge.

**Repricing later never edits these rows.** A non-draft price version's money columns are
frozen, so a new price is a new generation: retire `launch-2026` and insert the next one.
Invoices already issued keep the price they were raised under. The shape is:

```sql
insert into billing_price_versions
  (version_label, plan, billing_period, per_vehicle_monthly_incl_cents,
   months_charged, vat_rate_bps, status, effective_from)
values
  ('launch-2026', 'essential',    'monthly', <cents>,  1,  0, 'active', current_date),
  ('launch-2026', 'essential',    'annual',  <cents>, 10,  0, 'active', current_date),
  …;
```

`months_charged` is 1 for monthly and **10 for annual** — annual pre-pay is two months
free. It lives on the row rather than in a constant so the offer can change without
rewriting history.

**Invoices are immutable.** Every pricing input — plan, period, vehicle count, unit price,
months, price version, VAT rate, seller identity, who it was billed to — is snapshotted at
issue and frozen by `app.billing_freeze_invoice`. Changing the catalogue next year cannot
restate last year's bill. What may still change is what has been **paid**, and whether it
has been voided. Deleting an issued invoice is refused outright.

## 6. What counts as a billable vehicle

Non-deleted machines, **excluding** `retired` and `sold`. **A vehicle that is out of
service still counts** — it keeps its history and its papers, and a farm that could stop
paying by marking every tractor down would be a billing system with a hole in it.

`app.billable_asset_count` and `app.recount_farm_assets` (0251, which maintains
`farms.asset_count`) use the identical rule, and §(i) asserts the two agree.

Every invoice also writes a `billing_asset_snapshots` row, so "why does this bill say 37
vehicles?" is answerable months later, after tractors have been bought and sold.

## 7. Charging: three transactions, HTTP in the middle

```
1. claim    app.claim_billing_charge(invoice, ref, kind, amount)   fast, transactional
2. charge   POST to Paystack                                       slow, NO transaction
3. settle   app.settle_billing_attempt(...)                        fast, transactional
```

Holding a database transaction open across a payment API call is how a connection pool
dies at 03:00 and how a row stays locked long after the process that locked it has gone.

### Why a lost response never justifies a second charge

The reference is minted **in our database, before Paystack is contacted**, and persisted.

Two workers cannot both charge, and the reason is not "we check first" — two workers both
check, both see nothing in flight, and both charge. It is a **unique index**:
`billing_payment_attempts_inflight_uq` permits at most one `pending` or `unknown` attempt
per invoice. Claiming *is* inserting that row, so the second worker loses on a duplicate
key in the same instant. §(g) asserts it, and a mutation dropping that index is caught.

If the HTTP request times out we do not know whether the customer was charged. The attempt
settles **`unknown`**, never `failed`:

- `failed` would start the dunning ladder against a farm that may well have paid.
- `unknown` **blocks** the invoice — `app.due_billing_charges` excludes it entirely.

The only way forward is to ask Paystack about that exact reference. Nothing in the system
charges again to resolve an unknown.

## 8. The webhook

`POST /api/billing/paystack/webhook`

1. The **raw** body is read with `text()`, never `json()`. The signature covers the exact
   bytes Paystack sent; re-serialising is checking a signature over a body nobody sent.
2. Bodies over 1 MB are refused before hashing.
3. `x-paystack-signature` is verified **before anything is parsed or trusted** —
   HMAC-SHA512 of the raw body keyed with the **API secret key**, compared with
   `timingSafeEqual`. There is **no separate webhook secret**.
4. The event is persisted to `billing_webhook_events` **before** any side effect,
   idempotent on `(provider, dedupe_key)`. A duplicate delivery returns 200 and does
   nothing but bump `delivery_count`.
5. On a success event the transaction is **re-verified server-to-server**, and must match
   exactly on: our stored reference, the expected amount, `currency = ZAR`,
   `status = success`, and the invoice and farm in metadata. Any mismatch is recorded in
   `processing_error` and refused — never marked paid.

   Paystack does **not** ask for this. It is our choice, and the reason is that a signature
   proves the message came from Paystack, not that its contents match the invoice we
   intended to charge.
6. **200 is returned for anything successfully recorded.** Paystack retries a non-2xx every
   3 minutes for four attempts and then hourly for 72 hours, so returning 500 on a
   business-rule refusal buys three days of duplicate deliveries that cannot help.
   Non-2xx is reserved for "we recorded nothing, please send it again".

Paystack publishes a webhook IP allowlist (`52.31.139.75`, `52.49.173.169`,
`52.214.14.220`). It is **not** enforced in code, deliberately: the HMAC is stronger; behind
Vercel's proxy the source address is a forwarded header and therefore attacker-influenced;
and a provider IP change would silently break every payment. Apply it at the edge if you
want it.

## 9. Credentials

A Paystack `authorization_code` is not a reference. It is a **charging credential**:
whoever holds it, with our secret key, can take money from that customer's card.

- It lives in `billing_payment_methods.authorization_code`, which is **not granted to
  `authenticated` at the column level**. A browser session doing `select=*` on that table
  gets a permission error, which is the correct trade — an error is a bug report, a
  silently-omitted column is a leak nobody notices.
- **RLS cannot do this.** RLS filters rows; the owner is legitimately entitled to their own
  row, and the leak is a *column* of it.
- **The revoke is load-bearing.** `0102_grants.sql` runs
  `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
  authenticated`, so every table created in `public` afterwards is born with full CRUD
  granted. Measured before the fix, `authenticated` **could** read the authorization code.
  Every billing table now revokes first and grants back precisely what is meant. §(e)
  asserts it with `has_column_privilege`, and a mutation re-granting it is caught.
- Only `paymentMethodCredential()` in `src/lib/billing/service.ts` reads those columns, and
  what it returns goes straight into an adapter call — never a log, an error, a Sentry
  extra or a response body.
- Paystack will only charge an authorization presented with the **same email** it was
  created against. That is why `authorization_email` is stored beside the code and must not
  follow a user who later changes their address.
- An authorization is accepted **only** when Paystack marks it `reusable: true`, which is
  their own instruction. A one-off authorization stored as a subscription card produces a
  farm that appears set up and then fails every renewal. Enforced by a check constraint.

## 10. Who can see billing

Owners and Rapid Rise administrators. **Not** managers, mechanics, operators, or workshop
users — a contractor with an active `workshop_link` has legitimate access to a farm's
vehicles and no business whatsoever seeing what the farm pays Rapid Rise.

One predicate, `app.is_farm_billing_admin`, and §(b2) proves all four roles read zero.

`authenticated` has **SELECT only** on billing tables and **nothing at all** on
`billing_webhook_events` (a payload holds the customer's email and the full authorization
object). Every write goes through the service role from a route or action that re-checks
the role first. Two locks: the grant is absent *and* no permissive write policy exists.
§(d) asserts both, because relying on either alone is one mistake away from an open ledger.

## 11. Dunning, grace and cancellation

All nine values live in the single audited `billing_settings` row, so changing one is a
decision somebody makes and the audit log records — not a deploy nobody reviews.

**These are PROPOSED defaults awaiting founder sign-off** (decision #9). They are built and
tested at these values:

| Setting | Default | Why |
|---|---|---|
| `trial_days` | 14 | |
| `retry_offsets_days` | 3, 7, 14 | Three tries across a fortnight covers insufficient funds until payday, a reissued card, and the bank's own outage, without becoming harassment. |
| `grace_days` | 7 | Full access retained. The commonest reason a card fails in farming is that the money arrives next week; locking someone out of their maintenance records over a timing problem is both wrong and bad business. |
| `downgrade_to_plan` | `essential` | Gates close. **Nothing is deleted.** |
| `cancel_at_period_end` | true | They paid for the period. |
| `prorate_annual_additions` | false | Silently charging for a mid-year purchase is the fastest way to lose trust in a bill. |
| `payment_terms_days` | 7 | |

Failures notify the owner and manager in-app, and by email and push through the existing
delivery layer. **Billing works with no WhatsApp anywhere near it.**

## 11b. Refunds and disputes

**Founder decision, 12 September 2026 — the whole policy.**

Money only goes back when a person decides it should, one case at a time. The two ordinary
ways a farm ends up paying less are not refunds at all, and both already happen without
anybody doing anything:

| What they do | What happens | Refund? |
|---|---|---|
| **Move to a cheaper plan mid-cycle** (say R89 → R73) | They keep the plan they paid for until the period ends, then pay the smaller amount. `pending_plan` / `apply_pending_plan_changes`. | **No** |
| **Cancel** | Access runs to the end of the period they paid for, and they are simply not charged again. `cancel_at_period_end`, true by default. | **No** |
| **Upgrade mid-cycle** | Charged the pro-rata difference immediately — the direction that costs them money is the one that does not wait. | n/a |

What is left is genuinely individual, and there are only really three of them: *"I do not
recognise this deduction"*, *"you charged me after I cancelled"*, and *"somebody used my
card"*. Each is decided on its own facts. None of them is policy that can be automated,
because the same webhook arrives in all three cases and says nothing about which one it is.

**So every one becomes a support case** (`20260912160000`). A `charge.dispute.*` or a
`refund.processed` opens a ticket with the farm, the owner and how to reach them, the
subscription, the invoice, every payment on it (refunds included, so *"have we already
given some back?"* is answered before it is asked), the card, the attempt history and the
vehicle count — gathered at open time and frozen, so the ticket read next month shows what
was true when the complaint arrived. Cases are worked in the **RapidRise OS support
dashboard**; `20260912170000` posts them there, and `/admin/support` lists them here so a
case is never invisible when that connection is down.

**The card is labelled rather than asserted.** `evidence.card.source` is `charged` only when
the attempt genuinely used that card, and `farm_default` when it is merely the card on
file — which is the common case, because a first payment goes through hosted checkout and
captures the card during the transaction rather than charging one we hold. Presenting the
second as the first would hand somebody an identification they never made, in a case that
may end with a person being told their card was used without permission.

**The refund itself is still made in Paystack**, by the person handling the conversation.
There is no refund button in FleetWise and there is not going to be one.

---

**Founder decision, 11 September 2026**, kept because it is still the right answer to the
narrower question of what a refund does to a subscription once one has been made. There is no refund button in FleetWise and there
is not going to be one. A refund is made through Paystack by whoever is handling the
conversation, and what happens to the subscription depends on *why*:

| Why the refund | What happens to the subscription |
|---|---|
| **They asked for it** | Cancel it **immediately**. They wanted out; give them out. |
| **Something broke on our side** | **Leave it running.** The fault was ours; they keep the plan. |

FleetWise cannot tell these apart — Paystack's webhook says a refund happened and nothing
more — so **nothing is automatic**. The `refund.*` events raise a `billing_refund` alert
to Rapid Rise (and only Rapid Rise; the farmer does not need to be told their own refund
went through) whose wording states both branches, so the person reading it knows which one
they are in. Immediate cancellation is `setCancellation({immediate: true})` on the
subscription, and since `20260910200000` a late payment can no longer resurrect it.

**Disputes are the urgent case.** `charge.dispute.*` raises the same kind of alert, and it
names the deadline because the deadline is the whole point: South Africa gives roughly
**48 business hours** to respond before Paystack accepts the dispute on our behalf and
takes the amount out of a payout. Both alerts skip quiet hours, for that reason.

**A refund DOES move the ledger** (`20260911210000`). `refund.processed` calls
`app.billing_record_refund`, which writes a **negative payment** row; the existing rollup
then lowers `amount_paid_cents` and the invoice falls back out of `paid`. It is idempotent
on the refund reference, so a redelivered webhook records it once.

That last part was the trap, and it is worth knowing about before touching any of this: a
negative payment makes the invoice unpaid, and an unpaid invoice is what the nightly
charging shortlist looks for. Recording the refund on its own would have refunded a
customer at nine in the morning and charged them again at 03:20 the next day. So both
shortlists refuse an invoice carrying a refund — derived from the payment row itself, not
from a flag, for the same reason `status` is a rollup and never typed.

**What is still deliberately not automatic:** the SUBSCRIPTION, per the table above — a
webhook cannot tell why the money went back. And **disputes move nothing at all yet**: a
`charge.dispute.*` event raises its alert and does not touch the ledger, because what a LOST
dispute should do to a subscription is an open founder decision. The mechanism it would need
already exists, though — a lost dispute is economically a refund, so `billing_record_refund`
would give it both halves (a truthful ledger, and no re-charge) without new machinery.

## 12. The kill switch

Two parts, both required before a single rand can move:

| Variable | Effect |
|---|---|
| `BILLING_PROVIDER=paystack` | The adapter is live. Webhooks are verified and payments **reconciled** — nothing new is charged. |
| `BILLING_CHARGING_ENABLED=true` | Additionally permits **new** charges. |

Splitting them is what makes rollback safe. Pulling the provider entirely would strand a
customer who paid thirty seconds before somebody hit the switch.

Every method that would move money checks `chargingEnabled` **before making any network
request** — asserted on an injected fetch spy, not merely on the return value.

## 13. Runbook

### An attempt is stuck in `unknown`

That is the system working. It means an HTTP response was lost and the invoice is blocked
until somebody establishes what happened.

`/admin/billing` → the farm → **Check with provider** on that attempt. It calls
`transaction/verify` on that exact reference. If the provider says it succeeded, the
payment is recorded and the invoice settled. If it failed or never happened, the attempt is
closed and normal billing resumes. `reconcileStuckAttempts` also does this automatically as
**step 1** of the billing cron, before any new charge is attempted.

**Never** resolve an unknown by charging again.

### A duplicate webhook

Nothing to do. `(provider, dedupe_key)` is unique, and a redelivery bumps `delivery_count`
and returns 200.

### "Have we charged someone twice?"

Very hard, and checkable. `billing_payments` has unique indexes on both
`(provider, provider_transaction_id)` and `(provider, provider_reference)`, so the same
Paystack transaction cannot credit an invoice twice.

```sql
select invoice_id, count(*), sum(amount_incl_cents)
  from billing_payments where deleted_at is null group by 1 having count(*) > 1;
```
More than one row is normal for a part-payment or a refund (refunds are negative rows).
Compare `amount_paid_cents` with `total_incl_cents` on the invoice.

### Renewals suddenly fail for one farm

Check whether somebody edited an email. Paystack will only charge an authorization with the
email it was created against; `billing_payment_methods.authorization_email` is that email
and is deliberately not kept in step with `users.email`.

### Stopping everything

Set `BILLING_CHARGING_ENABLED=false` and redeploy. New charges stop; verification and
reconciliation continue.

**Do not roll back by deleting billing tables or rows.** The ledger is the record of money
that actually moved. Deleting it does not un-charge anyone; it destroys the evidence.
Issued invoices are immutable by trigger for the same reason.

## 14. The cron

`/api/cron/billing`, **separate** from `/api/cron/nightly` in both route and schedule, so a
billing failure cannot disrupt maintenance jobs and vice versa. Same
`Authorization: Bearer ${CRON_SECRET}` check. Steps, in order:

1. **reconcile stuck attempts** — first, so a lost response is resolved before anything else
2. capture asset snapshots
3. generate invoices
4. run charges
5. apply downgrades
6. close cancellations
7. enqueue reminders

Each step's failure is reported and the pass **continues** — a partial night is worth much
more than no night. Repeated execution is safe throughout.

## 15. What has and has not been verified

Stated plainly, so nobody mistakes "built" for "proven end to end".

**Verified by running:**

- All migrations apply cleanly to a fresh Postgres, in order (138 files, via PGlite —
  there is no Postgres in PATH on the build machine).
- `supabase/tests/billing_subscription.sql`: 17 sections, 110+ assertions, passing.
- **Mutation-tested: 8 mutations, 0 survivors**, with a clean control run that passes.
  One mutation *did* survive the first time — disabling the VAT guard — which is why §(h3)
  exists.
- 82 TypeScript tests across `safety`, `worker` and `webhook`, including: two simultaneous
  workers (the second claim returns NULL and does **not** charge), a timeout after a
  provider-side success settling `unknown` and being resolved by reconciliation rather than
  a re-charge, replay, amount/currency/reference/farm mismatch, and charging-disabled
  making **no network call at all**.
- TS and SQL VAT splits agree across 140 (amount, rate) pairs at five rates.
- Two real defects found by running rather than reading: a boolean primary key on
  `billing_settings` broke the shared `app_audit()` trigger, and the invoice generator
  created invoices as `open` and then could not add their own lines — **every invoice would
  have failed**.

**Not verified — needs credentials nobody had in this session:**

- **No live or test Paystack call has ever been made.** The adapter is built against
  Paystack's published contract (signature algorithm, `charge_authorization` fields, the
  same-email rule, the `reusable` flag, the retry cadence and the IP allowlist were each
  checked against their live documentation), and every HTTP call in the tests is mocked.
  Request and response shapes have not been confirmed against the real API.
- The webhook has never received a real Paystack delivery.
- The cron routes have not run on Vercel.
- `pnpm db:test` could not run (no Postgres in PATH); PGlite stood in. That is a real
  Postgres, but it is not the project's own harness.
