# FleetWise — feature gap review, 19 September 2026

**Question asked:** what is FleetWise still missing to be the complete system for running a
fleet as a subscription service?

**Method.** Checked against the code at `26f68bf`, not against earlier documents. This
builds on [`FLEETWISE_STATUS_CHECKLIST.md`](FLEETWISE_STATUS_CHECKLIST.md) (12 September)
and [`SYSTEM_AUDIT_2026-09-11.md`](SYSTEM_AUDIT_2026-09-11.md). The checklist warns it has
drifted twice, so nothing below is carried over from it unchecked. For each finding:

- **Confirmed**: I read the file and it is cited.
- **Not found**: a case-insensitive search of `supabase/migrations/` and `src/` for the
  obvious names returned nothing but unrelated matches. It is strong evidence, not proof;
  check before building.

No code was changed for this review.

---

## Headline

The breadth is already unusual for a product this age. It covers the register, QR capture,
service plans and kits, job cards, faults, parts and stock, fuel, TCO, budgets,
multi-site, AARTO, compliance packs, offline capture, voice, a public API, accounting export
and a working subscription engine. What is missing falls into four groups, in this order of
importance:

1. **Traps in daily capture.** A single mistyped meter reading cannot be undone, and some
   daily captures still need signal. These break the promise the product makes to the
   people who feed it.
2. **Alerts do not reach an owner who never opens the app.** `SCOPE.md` §1 says the farmer
   should get value without typing anything. Today alerts go in-app and by push only.
3. **Fleet modules competitors ship**: accidents and claims, driver licences, tyres, tank
   reconciliation, a maintenance calendar.
4. **Subscription lifecycle pieces**: MFA, a trial, promo pricing, customer support
   requests, ownership transfer.

---

## 1. Fix first — the product already claims these

### 1.1 A wrong meter reading cannot be corrected, and a replaced meter cannot be recorded — **Confirmed**
- `app` write paths reject any current/newer reading below the machine's reading
  (`20260903074034_farm_scoped_core_writes.sql:415`), and the offline path turns it into a
  `conflict` that "needs a person to resolve"
  (`20260908112437_atomic_offline_capture.sql:131`).
- There is no action for that person. `machines` exposes `addReading`, but no correct,
  void or replace action exists, and nothing updates or deletes `meter_readings`. RLS
  policies for it exist (`meter_readings_upd`, `meter_readings_del`) but have no caller.
- **Consequence:** type `12 500` for `1 250` once, and every true reading afterwards is
  refused. Service-due dates are also wrong from that moment. The same happens when an
  hour meter or instrument cluster is replaced, which is routine on older tractors.
- **Build:** owner/manager "correct a reading" (void with a reason, audited, recompute
  `current_reading` and service-due from the remaining history), plus a "meter replaced"
  event that sets a new baseline and carries service intervals across the offset.
  **Size: M.** It needs a migration and a suite section.

### 1.2 Fuel issue and driver-usage log are two unchecked writes — **Confirmed, still open**
- `src/app/(app)/fuel/actions.ts:154` inserts the issue, then `:172` inserts the usage log
  and never reads its result. The 11 September audit flagged it and it is unchanged.
- **Build:** one authenticated RPC, as the public QR fuel path already has. **Size: S.**

### 1.3 Offline capture skips fuel and pre-start checklists — **Confirmed**
- `src/lib/offline/types.ts` queues exactly `log_reading`, `report_fault`, `add_job_line`
  and `complete_job`.
- Fuel draws (the SARS-rebate trail) and pre-start checks both happen at the yard or
  bowser, often with the worst signal on the farm.
- **Build:** `log_fuel` and `submit_checklist` through the same idempotent `/api/sync`
  envelope. **Size: M.**

### 1.4 A failed pre-start check raises nothing — **Confirmed**
- Checklist fields are `checkbox / text / number / photo / rating / section_break`
  (`0290_checklists.sql`). There is no pass/fail meaning and no link to faults.
- A driver can record "brakes: no", and no fault, alert or out-of-service follows.
- **Build:** mark template fields as critical/defect items. A failed item opens a fault
  (urgency from the template), notifies, and can take the machine out of service.
  **Size: M.**

### 1.5 Alerts never leave the app unless it is installed — **Confirmed**
- `notification_channel` is `('whatsapp','inapp','email')`, but alert delivery exists for
  in-app and push only (`src/lib/push/deliver.ts`). Email (Resend, live) sends
  verification, billing receipts, documents, statements and scheduled reports, never a
  service, fault or licence alert.
- WhatsApp Stage 2 is still parked. It is the product's headline differentiator in
  `SCOPE.md` §1.
- **Build:** an email adapter on the existing notification queue, honouring the per-user
  preferences and quiet hours (F6). **Size: S–M.** WhatsApp remains a provider decision.

---

## 2. Fleet modules that are missing

| # | Gap | Evidence | Why it matters | Size |
|---|---|---|---|---|
| 2.1 | **Tank dip readings and reconciliation** | Not found (`dip`, `reconcil.*tank`). The fuel page shows a book balance only. | **In scope**, `SCOPE.md` §9: "deliveries − issues vs dip reading". The dip variance is how theft and leaks show up. | S–M |
| 2.2 | **SARS-format diesel logbook export** | `reports/fuel.csv` describes itself as the logbook *basis*. | `SCOPE.md` §9 promises the SARS-format usage and storage logbooks. It is the module's reason to exist. Have an accountant confirm the layout first. | M |
| 2.3 | **Driver/operator records**: licence code and expiry, PrDP, competency certificates, medicals | Not found. `licence_expir*` is the vehicle licence disc. | AARTO nominations are built, but nothing warns when the nominated driver's own licence or PrDP has lapsed. | M |
| 2.4 | **Accidents, incidents and insurance claims** | Not found. Every "accident" match is a code comment. | Bakkies and trucks: SAPS case number, third parties, insurer claim number, excess, repair job card, status. Faults only cover breakdowns. | M |
| 2.5 | **Maintenance calendar/planner** | No calendar view. Only statements and accounting use dates this way. | A week or month view of what is due and what is booked with which workshop. It is how a manager plans around harvest. | S–M |
| 2.6 | **Tyres**: position, fitment, tread checks, cost per km/hour | Not found. "Tyre" is only a fault category. | High for trucks, medium for tractors. Tyres are a large, trackable cost. | M–L |
| 2.7 | **Depreciation and book value** | Not found. | The accountant and the insurance schedule both ask for it every year. It complements the sale pack. | S |
| 2.8 | **Warranty claims** against a job card | Not found. Warranty *expiry* is tracked (F6). | Turns "was this under warranty?" into money recovered. | S |
| 2.9 | **Custom fields** on machines | Not found. | Every farm has one field nobody else has. Without it, it ends up in Notes. | M |
| 2.10 | **Move a machine between farms on one account**, keeping its history | Not found. | Multi-site (F7) makes this a real case. It is tenancy-sensitive, so design with RLS first. | M |

---

## 3. Subscription-service gaps

| # | Gap | Evidence | Note | Size |
|---|---|---|---|---|
| 3.1 | **MFA for owners and Rapid Rise admins** | Not found. The `mfa`/`totp` matches are unrelated. | Owners control card payments; `rr_admin` crosses every tenant. Supabase Auth supports TOTP; enforce `aal2` for `rr_admin` at minimum. | S–M |
| 3.2 | **Self-serve trial** | `billing_settings.trial_days` exists, but `/signup` → `/activate` requires payment. | `SCOPE.md` §12 promises "first month free after install". **A decision**, not a code gap. | Decision |
| 3.3 | **Promo / Founding Farmer pricing** | Not found for the subscription. `discount_cents` is on partner invoices. Price-version pinning gives grandfathering. | `SCOPE.md` §12's Founding Farmer rate "locked for life" has no mechanism beyond pinning. **A decision** on how. | Decision, then S–M |
| 3.4 | **Customer support request in the app** | Only an email address on `/billing`. `/admin/support` is Rapid Rise's side. | A "get help" form that opens a support case with the farm's context attached. | S |
| 3.5 | **Transfer farm ownership** | Not found. | Farms change hands and pass to the next generation. Today it needs Rapid Rise to edit roles by hand. | S–M |
| 3.6 | **Pay by debit order / EFT** | DebiCheck is Phase 3 (`FLEETWISE_STATUS_CHECKLIST.md` §B). | Many farms will not put a card on file. **A decision** on timing. | Decision |
| 3.7 | "What's new" notes, sign out other devices | Not found. | Low priority. | S |

---

## 4. Already decided — not gaps

Excluded by decision rather than overlooked (`SCOPE.md` §13 and later founder decisions):
GPS telematics, fuel-card import, WhatsApp Stage 2 until a provider is chosen, DebiCheck
until Phase 3, and a self-hosted SKU.

**`SCOPE.md` §13 no longer describes the real boundary.** It still lists parts inventory,
invoicing/accounting, store apps and full offline sync as a hard no. The product ships the
first two, and the request that produced this review asks for the last two. Recording the
current boundary in `SCOPE.md` and `FLEETWISE_FOUNDER_DECISIONS.md` would stop the next
session refusing work the founder has already approved.

---

## 5. Recommended order

1. **1.1–1.4.** Correctness of daily capture comes before anything new; this is the loop
   the 11 September audit asked to be proven first.
2. **1.5 email alerts** and **3.1 MFA**. Small, and they reduce risk immediately.
3. **2.1 + 2.2**, which finish the diesel module `SCOPE.md` already sells.
4. **2.3 + 2.4**, compliance that sits beside AARTO.
5. **Decisions 3.2, 3.3, 3.6.** Nothing to build until they are made.
6. **2.5–2.10 and 3.4–3.5**, in whatever order pilot farms ask for them.
