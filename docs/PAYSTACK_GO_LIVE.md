# Connecting Paystack — the manual steps

Everything in this file is a thing **a person has to do**, outside the codebase. The code
is built and verified; none of it can move money until the steps below are done
deliberately.

`docs/BILLING.md` explains how the system works. This file is only the checklist.

> **Nothing is charging anyone right now, and nothing can.** Two independent things
> prevent it, and both would have to be changed on purpose:
>
> 1. The price catalogue (`billing_price_versions`) is **empty**. With no active price
>    version the invoice generator raises no invoice, so there is nothing to charge.
> 2. `BILLING_CHARGING_ENABLED` is unset. Every code path that would move money checks it
>    first and returns without making a network request.

---

## 0. The decision that blocks everything else

**Which price table is real?**

| Source | Essential | Professional | Complete | Done-For-You |
|---|---|---|---|---|
| `docs/FLEETWISE_FOUNDER_DECISIONS.md` #1 | R44 | R73 | R89 | R250 |
| shipped `src/lib/entitlements.ts` | R39 | R69 | R99 | POA |

Both say VAT-inclusive, so only the numbers are in dispute. I have **not** picked one and
have **not** seeded either. Until you confirm, the catalogue stays empty and billing
cannot start.

Also outstanding, both with tested defaults you can accept or change
(`docs/FLEETWISE_FOUNDER_DECISIONS.md` rows 8 and 9):

- **Dunning policy** — 14-day trial; retries at 3, 7 and 14 days; 7-day grace; then the
  effective plan drops to Essential with nothing deleted; cancellation at period end; no
  proration on mid-term annual asset additions.
- **VAT registration** — recorded as **not registered**. While that holds, every invoice
  is forced to a 0% rate by a database trigger, no VAT line is shown, and invoices are
  correctly not headed "Tax invoice" (VAT Act s20(4)).

---

## 1. Paystack account (you)

1. **Register** at [paystack.com](https://paystack.com) as the **South African**
   registered business. (Paystack supports SA-registered businesses; Stripe does not —
   this is why Paystack was chosen.)
2. **Activate live mode.** They review company registration (CIPC), a bank account and
   director ID. **Start this early — it takes days, not minutes.** You can do everything
   else in test mode meanwhile.
3. **Get the API keys**: Settings → API Keys & Webhooks. You need the **secret key**
   (`sk_test_…` for now, `sk_live_…` later).
   - There is **no separate webhook secret**. Paystack signs webhooks with this same
     secret key. This is the single most common setup confusion.
   - We do **not** need the public key. The flow used here is hosted checkout — the
     browser never talks to Paystack's API directly, so no key is exposed to it.
4. **Confirm recurring is enabled.** Ask Paystack support to confirm **charge
   authorization / recurring charges** are enabled on the account. Without it the first
   payment works and every renewal fails.
5. **Decide the billing email address** customers will see, and whether you want a
   trading name on the invoice.

## 2. Webhook (you, in the Paystack dashboard)

Settings → API Keys & Webhooks → **Webhook URL**:

```
https://<your-domain>/api/billing/paystack/webhook
```

Set the **test** webhook URL to your Vercel Preview domain and the **live** one to
production. They are configured separately.

Notes worth knowing:

- The route verifies `x-paystack-signature` (HMAC-SHA512 of the raw body, keyed with your
  secret key) **before parsing anything**, and refuses anything unsigned.
- Paystack expects a `200`. On anything else it retries every 3 minutes for 4 tries, then
  hourly for 72 hours. Our route returns 200 for anything it has successfully recorded, so
  a business-rule refusal does not buy you three days of duplicate deliveries.
- Paystack publishes a webhook IP allowlist (`52.31.139.75`, `52.49.173.169`,
  `52.214.14.220`). We deliberately do **not** enforce it in code — the signature is
  stronger, the source IP behind Vercel's proxy is a forwarded header and so
  attacker-influenced, and a provider IP change would silently break every payment. If you
  want it, apply it at the edge/WAF, not in the app.

## 3. Environment variables (you, in Vercel)

Add to **Preview first**. See `.env.example` for the full commentary.

| Variable | Preview | Production (initially) |
|---|---|---|
| `BILLING_PROVIDER` | `paystack` | *(leave unset)* |
| `BILLING_CHARGING_ENABLED` | `true` | **`false`** |
| `PAYSTACK_SECRET_KEY` | `sk_test_…` | *(leave unset)* |
| `FLEETWISE_VAT_NUMBER` | *(blank — not registered)* | *(blank)* |

Already present and reused: `NEXT_PUBLIC_SITE_URL` (every callback URL is built from it,
never from the `Host` header) and `CRON_SECRET`.

**Never** prefix any of these with `NEXT_PUBLIC_`. The secret key and the stored card
authorization codes are charging credentials — treat them like passwords.

## 4. Cron (you, in Vercel)

`vercel.json` now declares a **second** schedule:

```
/api/cron/nightly   03:00   (unchanged — maintenance)
/api/cron/billing   03:20   (new — billing only)
```

Deliberately separate routes and schedules: a billing failure must not take the nightly
maintenance pass with it, and vice versa. Vercel sends `Authorization: Bearer ${CRON_SECRET}`
automatically once `CRON_SECRET` is set on the project.

## 5. Database (you, once)

Apply the three migrations to the Supabase project:

```
supabase/migrations/20260903160000_saas_billing_core.sql
supabase/migrations/20260903160100_saas_billing_payments.sql
supabase/migrations/20260903160200_saas_billing_engine.sql
```

Then, in `billing_settings` (one row), fill in the selling identity that appears on
invoices: `legal_name`, `trading_name`, `reg_number`, `billing_address`, `billing_email`.
Leave `vat_registered` **false** until you actually register.

**Do not insert anything into `billing_price_versions` yet.** That is step 0.

## 6. Test it in Preview (me or you, once keys exist)

With test keys, in Preview only. Paystack's test cards are in their docs.

- [ ] Hosted checkout completes and the card is stored
- [ ] The stored authorization comes back `reusable: true` (a `reusable: false` one is
      refused on purpose — it would appear to work and then fail every renewal)
- [ ] A recurring charge against the stored authorization succeeds
- [ ] A **declined** card is recorded as a failure and starts the retry ladder
- [ ] A **duplicate** webhook delivery changes nothing the second time
- [ ] A payment recorded by webhook and by verify does not double-credit
- [ ] A farm in grace is downgraded, keeps all its data, and is restored on payment

## 7. Going live (you, deliberately)

Do not do any of this until steps 0–6 are done and you are satisfied.

1. Confirm the final price table, and seed exactly one active price version per plan and
   period. This is a single INSERT — `docs/BILLING.md` has the statement.
2. Set the live webhook URL in Paystack.
3. Set `PAYSTACK_SECRET_KEY` (live) and `BILLING_PROVIDER=paystack` in **production**,
   with `BILLING_CHARGING_ENABLED` still **`false`**.
4. Watch `/admin/billing` for a cycle: invoices should be raised and **nothing charged**.
5. Only then set `BILLING_CHARGING_ENABLED=true`.

## 8. Stopping it again

**To stop all charging:** set `BILLING_CHARGING_ENABLED=false` and redeploy. New charges
stop immediately; webhooks are still verified and payments already in flight are still
reconciled, so nobody who paid thirty seconds earlier is stranded.

**Do not** roll back by deleting billing tables or rows. The ledger is the record of money
that actually moved; deleting it does not un-charge anyone, it just destroys the evidence.
Invoices are immutable by trigger once issued for the same reason.

---

## What I could not verify, and why

Stated plainly so nobody mistakes "built" for "proven end to end":

- **No live or test Paystack call has ever been made.** There were no credentials
  available in this session. The adapter is built against Paystack's published contract
  (verified against their live documentation for the signature algorithm, the
  `charge_authorization` fields, the same-email rule, the `reusable` flag, the retry
  cadence and the IP allowlist), and every HTTP call in the tests is mocked. The
  request/response shapes have not been confirmed against the real API.
- **The webhook has never received a real Paystack delivery.**
- **The cron routes have not run on Vercel** — they need `CRON_SECRET` and the service-role
  key set on the project.
- `pnpm db:test` could not be run: there is no Postgres in PATH on this machine. Instead
  every migration was applied to a real Postgres via PGlite (WASM) and exercised with an
  assertion suite. That is a genuine database, but it is not the project's own harness.

Give me test keys and I can close the first two.
