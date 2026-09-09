# Self-serve sign-up and quota billing — the plan

**Status: PLANNED, not built.** Nothing in this document is implemented. It exists so the
decisions are recorded before code is written, and so the next person can see why the
model changed rather than guessing.

Founder decisions taken 8 September 2026, in conversation:

| Question | Decision |
|---|---|
| Asset count | **Chosen at sign-up (a quota)**, not counted each month |
| At the limit | **Block the add**, offer to buy more slots |
| Trial | **None.** Payment activates the account |
| Who signs up | **Anyone, off the website** |

The reasoning on the last one is the founder's and it is sound: with no free tier, an
abandoned sign-up never becomes a farm, because it never gets access. It costs a dormant
row, not a junk account.

---

## 1. The flow

```
1. Choose a plan        Essential / Professional / Complete / Done-For-You
2. Choose how many      "How many vehicles?"  →  price updates live
3. Enter details        farm name, your name, email, password
4. Pay                  Paystack hosted checkout
5. Subscription live    access opens, receipt emailed
```

Steps 4 and 5 are **already built and proven in production** (8 September 2026): hosted
checkout, signed webhook, ledger, stored card, branded receipt PDF, and the automatic
renewal a month later. Steps 1–3 do not exist; step 3 exists only as an administrator
creating a farm on someone's behalf.

## 2. The order of operations, and why it is not negotiable

**The account is created BEFORE the payment, in a `pending` state with no access.**

```
create farm + owner + subscription   (pending — no access, no data)
        ↓
raise the invoice
        ↓
Paystack hosted checkout  ────────►  signed webhook confirms
        ↓
flip to active — access opens, receipt sends
```

The tempting alternative — take the money, then create the farm on success — is wrong.
Any failure between Paystack saying "paid" and the database writing the farm leaves
**money taken with nothing to attach it to**, and no row to reconcile against. An
abandoned sign-up leaves a pending farm nobody can log into, which is tidy-up-able; a
successful payment with no farm is a refund and an apology.

This mirrors what `beginCheckout` already does with charge attempts: it claims the attempt
row *before* contacting Paystack, precisely so a lost HTTP response is recoverable rather
than a mystery.

## 3. The model change: counted → quota

Today `app.billable_asset_count` COUNTS machines that are not deleted, retired or sold,
and the invoice is that number × the per-vehicle price. Add a bakkie in March and March's
invoice is R73 bigger. Nobody chooses anything.

Under the new model the subscription carries an `asset_quota` — the number bought — and
**that** is what is billed. The counted number does not disappear; it becomes the "you are
using 7 of 10" figure on `/billing`, and the thing the ceiling is checked against.

| | Metered (today) | Quota (planned) |
|---|---|---|
| Billed on | machines counted each period | slots bought |
| Monthly amount | moves | fixed until they change it |
| Adding one more | just works | blocked at the ceiling |

`billing_invoices.asset_count` should snapshot the **quota billed**, since that is what the
money was for. Keep the counted figure alongside it if an invoice needs to explain both.

## 4. Where the ceiling is enforced

A quota is only as good as its weakest path. There are **three** ways a machine is created
today, and all three must check:

| Path | File | Note |
|---|---|---|
| `createMachine` | `machines/actions.ts:112` | the ordinary "add a vehicle" form |
| `importMachines` | `machines/actions.ts:306` | **CSV bulk import** |
| `syncClientVehicles` | `contractor/clients/actions.ts` | a CONTRACTOR copying their notebook vehicles into the farm's fleet |

Two things about that list:

- **The check is server-side, in the action.** Not in the UI. A server action is an
  endpoint; hiding a button is not enforcement. This is the same rule F7 exists to uphold.
- **The third path is a contractor**, not the farm. If the farm is at its ceiling, the
  contractor's sync must be refused too — and the message has to make sense to someone who
  is not the one paying ("Rooikoppies is at its vehicle limit; ask them to add slots"),
  not "upgrade your plan".

**CSV import must be all-or-nothing.** Importing 50 rows into 10 free slots should be
refused before a single row is written, naming the shortfall. A partial import that
silently stops at the limit leaves the farmer believing their fleet is loaded when it is
not — worse than a clean refusal.

**Still to verify at build time:** whether `/api/v1/[resource]` can POST a machine. The
offline `/api/sync` route only READS machines (meter and fault capture), so it is not a
creation path.

## 5. The `pending` state, and not breaking what already works

`billing_subscription_status` gains `pending`. Access is refused while a subscription is
`pending`.

**The gate must be "a subscription exists AND it is pending", never "no active
subscription".** Weltevrede Boerdery is on the demo project today with no subscription row
at all, and every farm onboarded before this feature will be the same. If absence of a
subscription meant no access, this change would lock out every existing customer on the
day it shipped.

So:

```
no subscription row     → full access   (grandfathered, and what admin-created farms get)
subscription = pending  → no access     (paid nothing yet)
anything else           → today's rules
```

## 6. Edge cases, and the answers

**Someone abandons checkout, then signs up again with the same email.** Their pending
`auth.users` row already owns that address, so a second sign-up will collide. The flow
must recognise the email, find the pending subscription, and resume it at the payment step
rather than refusing. This is the most likely thing to be got wrong and the most annoying
to the customer.

**They want to reduce their quota below what they are using.** Refuse it. Ten vehicles on
file cannot become a seven-slot subscription without deleting three real assets, and
nothing in this product deletes a farmer's records to make a billing change work. Tell them
what to retire first.

**They retire or sell a vehicle.** It stops counting against the ceiling (retired and sold
are already excluded everywhere), but the quota — and the bill — do not change until they
say so. That is the deal with a quota, and `/billing` should say it plainly.

**They add slots mid-period.** Charge the difference immediately, or let it land on the
next invoice? Not decided. Proration is the one piece of this that is genuinely fiddly and
it can ship in a second pass — start by taking the new quota from the next period.

**Dormant pending farms.** Harmless (no access, no data), but they should be swept — a
nightly job soft-deleting pending subscriptions older than, say, seven days, along with
their farm and auth user, so an abandoned email can be reused cleanly.

## 7. Deliberately NOT in this plan

- **Contractor/workshop sign-up.** Partners stay invite-only, as they are now.
- **Proration** on mid-period quota changes (see above).
- **Changing the dunning ladder.** What happens when a renewal fails is unchanged by any
  of this, and is documented in `docs/BILLING.md`.
- **Anything touching `partner_documents` / `partner_payments`.** The contractor-to-farmer
  ledger is a different system and Paystack must never touch it.

## 8. Build order

1. `billing_subscriptions.asset_quota` + the `pending` status, and the access gate — with
   the grandfathering rule above proven by an assertion before anything else lands.
2. Ceiling enforcement on all three creation paths, server-side, with the isolation suite
   asserting each one refuses.
3. The public sign-up route: plan picker, quantity picker, live price, details form.
4. Wire it to the existing `beginCheckout` → webhook → activate path (mostly already
   built).
5. Self-serve "change plan" and "add vehicles" on `/billing`.
6. The dormant-pending sweep on the nightly cron.

The billing engine itself barely changes: it already charges `unit_price × count ×
months` and snapshots the result onto an immutable invoice. What changes is where `count`
comes from.
