# Connecting Paystack — the manual steps

Everything in this file is a thing **a person has to do**, outside the codebase. The code
is built and verified; none of it can move money until the steps below are done
deliberately.

`docs/BILLING.md` explains how the system works. This file is only the checklist.

> **Nothing is charging anyone right now, and nothing can.** There were two independent
> locks. Prices are now confirmed and seeded, so one is released; the other still holds:
>
> 1. ~~The price catalogue is empty.~~ **Released 2026-09-04** — prices confirmed and
>    seeded, so invoices can now be RAISED.
> 2. `BILLING_CHARGING_ENABLED` is unset. Every code path that would move money checks it
>    first and returns **without making a network request**. Nothing can be CHARGED.

---

## 0. ✅ Prices — CONFIRMED 2026-09-04

The founder document was confirmed correct and is seeded: **Essential R44 / Professional
R73 / Complete R89 / Done-For-You R250** per vehicle per month, VAT-inclusive, with annual
charging ten months (two free). Migration `20260904120000`.

That releases the first of the two locks. **`BILLING_CHARGING_ENABLED` is still unset, so
nothing can be charged** — invoices can now be raised and watched first, which is exactly
the order you want. The superseded conflict, for the record:

| Source | Essential | Professional | Complete | Done-For-You |
|---|---|---|---|---|
| `docs/FLEETWISE_FOUNDER_DECISIONS.md` #1 | R44 | R73 | R89 | R250 |
| shipped `src/lib/entitlements.ts` | R39 | R69 | R99 | POA |

Still outstanding, both with tested defaults you can accept or change
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

The price catalogue is seeded by the fourth migration:

```
supabase/migrations/20260904120000_saas_billing_launch_prices.sql
```

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

1. ~~Confirm the final price table.~~ Done — `launch-2026` is seeded.
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

---

## 9. Added 11 September 2026 — the sign-up and lifecycle work

Five things that did not exist before this date now do, and three of them need a decision
from you rather than a deployment.

### 9.1 Decide how long a lapsed farm stays open — `lapsed_grace_days`

**This is live and it will close accounts.** Until today nothing ever took access away: a
farm that stopped paying kept the product on the Essential plan for ever, and a farm that
cancelled kept all of it. `app.farm_billing_gate` now answers `closed` once a subscription
has been `cancelled` or `downgraded` for longer than this window.

```sql
-- Look at it
select lapsed_grace_days from public.billing_settings where singleton;

-- Change it (no migration, no deploy)
update public.billing_settings set lapsed_grace_days = 30 where singleton;
```

- **30** is the default and what is set now.
- **0** closes the day after the terminal event.
- **3650** effectively restores the old behaviour of never closing, if this turns out to be
  too sharp in practice. That is a supported setting, not a hack.

Whatever you choose, `/terms` says *"If the account stays unpaid beyond that, we close it"*
without naming a number, so changing the window does not make the terms wrong. Naming a
number there would.

### 9.2 Have the terms and the privacy notice read by a lawyer

`/terms` and `/privacy` are live, linked from the sign-up form, and the tick is enforced on
the server. They are accurate — every clause describes something the software actually does,
and several were written by reading the code — **but they are not legal advice and nobody
qualified has read them.**

Before a stranger pays:

1. Have someone qualified read `src/lib/legal.ts` (the wording lives there, not in the
   dictionaries — see the note at the top of that file for why a contract is the one string
   in this product that is deliberately not translated).
2. Apply whatever they say.
3. **Bump `TERMS_VERSION`** in the same file. Every sign-up records the version it was shown,
   so the question "what did this person actually agree to" has an answer.

### 9.3 Email is now part of signing up

A verification link goes out at sign-up. If email is not configured the sign-up still
works — deliberately, because a mail outage must not cost a customer — but nobody is ever
asked to confirm their address, and the address is the only way back into the account.

- `RESEND_API_KEY` and `EMAIL_FROM` must be set in Vercel Production. (Verified working from
  a developer machine on 11 September: Resend accepted the message.)
- **`NEXT_PUBLIC_SITE_URL` must be correct**, and this is new: the verification link is built
  from configuration ONLY and never from a request header, because a forged `Origin` would
  have us email somebody a link to another domain over our own name. If it is unset or not a
  real http(s) URL, `sendVerificationEmail` **refuses to send** rather than emailing a broken
  link. Nothing else breaks, but nobody gets verified.

### 9.4 Two quality gates are not in CI

`scripts/error_coverage.mjs` and `scripts/design_lint.mjs` are **untracked** — they exist
only in one developer working tree, are not on `main`, and the `package.json` entries for
`errors:check` and `design:lint` are uncommitted too. `CLAUDE.md` describes both as shipped.

`i18n:parity` IS committed and does run.

Whoever owns the UI/palette branch should land them. Until that happens, the two checks that
catch "a raw error code reached a customer" and "this colour token is not defined" only run
when somebody remembers to run them by hand.

### 9.5 What is now testable that was not

Nothing here needs you, but it is worth knowing the shape changed:

- A farm can be driven all the way to `closed` and back to paying without anybody at Rapid
  Rise touching the database — `/closed` offers reopen and a full data export.
- A person can change their own name, email and password at `/account`. Before today nobody
  could change a password at all.
- A paid invoice's receipt can be fetched at any time from `/billing`, not only from the one
  email it was sent in.

---

## 10. The honest state of it, 11 September 2026

**Proven on production:** a live Paystack payment end to end; the webhook signature on five
real deliveries; reconciliation in both directions; the `unknown`-attempt guard; the whole
nightly pass; sign-up creating a farm, owner, subscription and invoice in one transaction;
the gate closing and reopening; email verification sending through Resend.

**Still never done:** a real Paystack DECLINE (test mode accepts every valid stored
authorization, so this needs a declining card put through hosted checkout in a browser); the
billing cron firing on Vercel's schedule rather than being run by hand; and a refund or
dispute moving anything in the ledger — both still only raise an alert.

**Still ahead of you:** the Starter Business **lifetime collections cap**. When it is
reached, Paystack DISABLES payments for the business until it is upgraded to a
**Registered Business**, which has no collection limit.

**Corrected 12 September 2026.** This line previously said **R80,000**. Paystack's own
business-types page lists South Africa at **ZAR 1,000,000**, and notes that South
Africa's *Sole Proprietorship* variant — what an unregistered SA merchant actually gets
— has a HIGHER limit than a regular Starter. The old figure is not supported by the
current source, and planning against it meant planning against roughly a twelfth of the
real headroom.

**Check your own account rather than any article.** A published limit is a default and an
account can differ. Compliance → Profile shows your business type; the dashboard shows
collections to date. With your LIVE secret key:

```bash
curl -s -H "Authorization: Bearer $PAYSTACK_LIVE_SECRET" \
  https://api.paystack.co/transaction/totals
# total_volume is in CENTS: 100000000 = R1,000,000.00
```

**To upgrade** (Dashboard → Compliance → Profile → Business Type), a South African
registered business needs: the **CIPC certificate of registration**, the **CIPC
enterprise number**, a **bank confirmation letter for the corporate account, no older
than six months**, and **details of at least one director**.
