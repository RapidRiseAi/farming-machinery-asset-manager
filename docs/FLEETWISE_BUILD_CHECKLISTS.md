# FleetWise — per-feature build checklists

Granular, checkbox-level acceptance for each build workstream, so no feature or function is missed. Derived from `docs/FLEETWISE_GAP_ANALYSIS.md` (tickets T1–T14) and the FleetWise spec (`docs/fleetwise-build-checklist.pdf`). Each agent owns exactly one section, one branch, one migration range.

**Decisions in force (this build effort):** scope = **P0 + key P1s**; **voice / WhatsApp / billing-payments are DEFERRED** pending provider research (`docs/FLEETWISE_PROVIDER_RESEARCH_PROMPT.md`); the product is being **renamed FarmGear → FleetWise**; agents push a feature branch and the orchestrator reviews the diff before it lands on `main`.

---

## G · Global conventions (EVERY agent MUST follow)

- [ ] Read `CLAUDE.md`, `docs/SCOPE.md`, `docs/FLEETWISE_GAP_ANALYSIS.md`, and this file's global section before writing code.
- [ ] **Tenancy:** every business table carries `farm_id` + a composite FK `(child_id, farm_id) → parent(id, farm_id)`; enable **and** force RLS; add `sel/ins/upd/del` policies gated by `app.has_farm_access(farm_id)` (reads also require `deleted_at is null`) — copy the loop in `0101_rls_policies.sql`. Add grants per `0102`. `anon` gets **zero** table access.
- [ ] **Audit:** attach the `app_audit()` trigger to every new table (see the array loop in `0008_audit_and_triggers.sql`).
- [ ] **Soft delete:** every table has `deleted_at timestamptz, deleted_by uuid`.
- [ ] **Money:** integer cents, **ex-VAT**, `bigint`; never floats. Reuse `src/lib/money.ts` (`parseRandsToCents`, `exVatCents`, `rands`).
- [ ] **SECURITY DEFINER** functions: `set search_path = public, pg_temp`; `revoke execute ... from public, anon, authenticated`; grant to `service_role` only if cron/service-invoked; PostgREST-callable wrappers live in `public.` and follow the `0205` `cron_*` pattern.
- [ ] **Public/QR path stays ZERO-anon-DB:** anything anonymous goes through a service-role server route/action validated by the per-machine `public_token`.
- [ ] **i18n:** every user-facing string is a `t()` key present in **both** `src/lib/i18n/en.json` and `src/lib/i18n/af.json`, kept at **exact key parity** (run the parity check). Afrikaans must be a real translation.
- [ ] **Rename FarmGear → FleetWise** in any file you touch: `src/app/layout.tsx` metadata, `public/manifest.webmanifest`, `src/lib/env.ts` `APP_NAME` default, i18n `app.name`, README references, and any visible "FarmGear" string. Keep storage-bucket ids and the `farmgear:` localStorage prefixes stable unless you migrate them safely.
- [ ] **Tests:** add every new table to `supabase/tests/rls_isolation.sql` with the standard assertions (own-farm visible, cross-tenant = 0, workshop scoping).
- [ ] **Bundle:** keep shared first-load JS lean (currently ~102 kB) — server components by default, import kit pieces from direct module paths (see `src/components/ui/README.md`).
- [ ] **Gates (all green before done):** `pnpm install` → `pnpm typecheck` → `pnpm lint` → `pnpm build` → `pnpm db:test`. Report the real output; never claim green if red.
- [ ] **Delivery:** work on your named branch; commit messages end with the two trailer lines (Co-Authored-By + Claude-Session as provided in your task); `git push -u origin <branch>`. **Do NOT push to `main`** (the orchestrator reviews and merges). No model identifier anywhere in commits/PR/code.
- [ ] Use **only** your assigned migration-number range.

---

## F1 · Cost & TCO spine  · branch `claude/fleetwise-cost-tco-spine` · migrations 0210–0219
Covers FR-10.1/10.2/10.3, FR-8.2/8.4, FR-4.5, FR-3.2 (finance), FR-11.2, FR-11.3; fixes D-2/D-3.

**Data model**
- [ ] `cost_entries` table: `id, farm_id, machine_id, type (enum purchase|finance|fuel|parts|labour|invoice|other), amount_cents bigint, vat_rate_bps int, source_type text, source_id uuid, occurred_on date, note text, created_by uuid, created_at, deleted_at, deleted_by`; composite FK to `machines(id,farm_id)`; indexes `(farm_id)`, `(machine_id, occurred_on)`; full RLS + grants + audit trigger.
- [ ] Add machine finance fields: `finance_provider text, finance_total_cents bigint, finance_monthly_cents bigint, finance_term_months int, finance_interest_bps int`.

**Backend**
- [ ] SECURITY DEFINER triggers keep `cost_entries` in sync from `job_card_lines` (parts/labour/other → cost type) on insert/update/soft-delete; respect the job-card lock.
- [ ] Seed a `purchase` cost entry from `machines.purchase_price_cents` (occurred_on = purchase_date) and a `fuel` entry from `fuel_deliveries` cost (so TCO already includes fuel before the fuel UI ships).
- [ ] `app.machine_tco(machine)` (or a view) summing all non-deleted `cost_entries`.

**UI / metrics**
- [ ] Machine detail "lifetime stats": show **TCO** (all cost types), cost-per-hour and cost-per-km on a **consistent basis** (lifetime cost ÷ lifetime meter) — remove the period-÷-lifetime bug (D-2).
- [ ] Reports (`reports/data.ts` + page): rank machines by TCO; keep spend-by-type/period coherent; add **cost-per-km** column for km assets.
- [ ] FR-11.2 true "breaks most often": rank by **repeat repairs per machine** (count of repair/fault job cards per machine), not just part-description frequency — add alongside the existing lists.
- [ ] FR-11.3: add a **per-site/per-group filter** to reports (works with multi-site once F7 lands; scope gracefully until then).
- [ ] Job-card detail: upload **quote / invoice / photo** attachments (reuse `attachments` + `jobcard-photos` bucket + the `uploadFaultMedia` service-role pattern); recording an invoice **amount** creates an `invoice` cost entry (FR-8.4).

**Verify**
- [ ] Entering a job-card part line increments the machine's TCO and appears in cost-by-machine.
- [ ] Uploading a contractor invoice with an amount raises TCO by that amount.
- [ ] cost-per-hour on the detail page equals the value in reports for the same machine (no more disagreement).

---

## F2 · Offline-first & sync  · branch `claude/fleetwise-offline-sync` · migrations 0220–0229
Covers FR-1.3, FR-15.1–15.4, FR-9.3; fixes D-1.

**Service worker / shell**
- [ ] Hand-rolled `public/sw.js` (no heavy deps) registered via a small client component in the app shell; precache shell + static; stale-while-revalidate for last-viewed asset data; graceful no-SW fallback.
- [ ] App opens and renders the last-viewed data with the network disabled.

**Local queue**
- [ ] IndexedDB mutation queue (`src/lib/offline/*`, tiny wrapper) intercepting: **log meter reading, report fault (app + public QR), add job-card line, complete job card**. Each mutation carries a client-generated **idempotency UUID** + client timestamp; UI confirms optimistically offline.

**Sync**
- [ ] `src/app/api/sync/route.ts` applies queued mutations **idempotently** (dedupe by client UUID); server `sync_log`/conflict table (RLS + audit) records applied + conflicting mutations.
- [ ] Auto-flush on reconnect; after flush, dependent metrics recompute (readings already trigger `app.recalc_machine_service`).
- [ ] **Deterministic conflict resolution** (FR-15.3): last-writer-wins by timestamp; the superseded value is preserved in `audit_log`/conflict table — **no silent loss**. Include a forced-conflict test proving both records survive for audit.
- [ ] **Sync status indicator** in the shell: online/offline, pending count, "syncing…".
- [ ] **Offline media** (FR-15.4): queue photos in IndexedDB; upload on reconnect.

**Verify**
- [ ] Offline → log a reading + fault + job line → go online → all three land exactly once (replay-safe).
- [ ] Two conflicting offline edits reconcile deterministically; both values are recoverable from audit.

---

## F3 · Field capture & accountability  · branch `claude/fleetwise-field-capture` · migrations 0230–0239
Covers FR-13.1, FR-7.2, FR-7.3, FR-7.5, FR-9.2, FR-3.6.

**AARTO driver-usage log (FR-13.1)**
- [ ] `usage_logs` table: `id, farm_id, machine_id, driver_user_id uuid null, driver_name text null, occurred_on date, meter_reading numeric, source (extend meter_source: +app), note, created_at, deleted_at, deleted_by`; composite FK; full RLS + grants + audit.
- [ ] Write a usage_log when a reading is captured by a known user, when a job card completes (driver = mechanic/operator), and allow selecting the driver at capture.
- [ ] Machine detail "who operated / when" view; a query answering "which driver operated machine X on date D".

**Fault → out-of-service (FR-7.5) + lifecycle (FR-7.3)**
- [ ] Add `out_of_service` to the `machine_status` enum (own migration step — `ALTER TYPE ADD VALUE` can't share a txn with dependent DDL). Treat it as **active-but-down** (NOT excluded like retired/sold); keep retired/sold exclusion intact. Update `machine-options.ts`, `statusLabel`, dashboard/report filters, i18n.
- [ ] Reporting a `stopped`-urgency fault sets the machine `out_of_service` (owner/manager can revert).
- [ ] Extend fault lifecycle to include **Acknowledged** and **In progress** states and an **assignee** (add `assigned_to uuid` + statuses); update the faults UI + transitions (keep existing open/in_job/scheduled/resolved semantics working).

**Fault location (FR-7.2)**
- [ ] `fault-capture.tsx` captures optional geolocation (permission-gated, silent fallback); store `lat`/`lng` on `faults`; show location on the faults list.

**QR quick actions (FR-9.2)**
- [ ] `/m/[token]` presents a clear quick-action menu: report fault (exists), log reading (exists), **log service** (new — token-gated service-completion capture via service-role). Leave a clearly-disabled "log fuel" placeholder (fuel ships in F4) — do **not** build fuel here.

**Assign default operator (FR-3.6)**
- [ ] Add `assigned_operator_id` to `MachineFields` (select of farm operators) + wire in `machines/actions.ts` create+update; show on detail; pre-fill the driver on captures.

**Verify**
- [ ] Logging a reading as a signed-in operator creates a matching usage_log with the right driver.
- [ ] A "stopped" fault flips the machine to out_of_service and it still counts as active-but-down on the dashboard.

---

## F4 · Fuel module  · (Wave 2) branch `claude/fleetwise-fuel` · migrations 0240–0249
Covers FR-6.1–6.3; §23 fuel metrics. **Depends on F1** (writes fuel `cost_entries`).

- [ ] Fuel capture UI (app + QR quick action) writing `fuel_issues`/`fuel_deliveries` (tables exist, `0007`): litres, cost, date, meter, operator, activity.
- [ ] Consumption engine: **L/hr** and **L/100km** per asset + trend, from issues vs meter deltas.
- [ ] Anomaly detection: flag entries deviating from the asset's rolling baseline (leak/theft) + enqueue a `fuel_anomaly` notification (0205 pattern) and notify relevant roles (FR-14.2).
- [ ] Fuel cost flows into `cost_entries`/TCO (coordinate with F1's fuel rollup).
- [ ] Dashboard/report fuel widgets; QR "log fuel" action (finish the F3 placeholder).
- [ ] i18n both languages; RLS test coverage already exists for fuel tables — extend if columns change.

---

## F5 · Plans & entitlement gating (framework; payments deferred)  · (Wave 2) branch `claude/fleetwise-entitlements` · migrations 0250–0259
Covers FR-19.2 (gating) and the non-payment parts of FR-19.1/19.3. **Payment integration is DEFERRED** (needs provider research).

- [ ] Replace `farm_tier` with the four real plans **Essential / Professional / Complete / Done-For-You** (migration + data map from starter/standard/large); add a `subscriptions` concept (plan, asset_count, billing_period, status) or extend `farms`.
- [ ] `app.has_entitlement(farm, feature)` helper + a central entitlement map (dashboard = Professional+, voice AI & AARTO = Complete+, etc. per FR-19.2).
- [ ] Enforce entitlements **server-side** in the relevant routes/actions (deny under-plan access, not just hide UI); show upgrade prompts.
- [ ] Admin UI to set plan + view asset count; per-vehicle count surfaced (pricing display only — no charging yet).
- [ ] Leave clean seams (interface + env-gated adapter) for the payment provider chosen after research.
- [ ] i18n both languages; RLS/isolation tests updated.

---

## F6 · Compliance reminders & push  · (Wave 2) branch `claude/fleetwise-compliance-push` · migrations 0260–0269
Covers FR-4.7, FR-13.3, and FR-14.1 push. **Push depends on F2's service worker.**

- [ ] `licences`/`documents` table for vehicle licence & warranty expiries (per machine): type, number, expiry_date, reminder settings; RLS + audit.
- [ ] Surface warranty (`machines.warranty_expiry_*`, already stored) + licences on machine detail with status (ok/expiring/expired).
- [ ] Extend the `0205` notification engine: **warranty/licence expiry** reminders (due-soon/overdue) honouring thresholds + quiet hours; wire into the nightly cron.
- [ ] **Web Push** (VAPID, self-hosted — no external provider): `push_subscriptions` table, subscribe UI, SW push handler, deliver service-due/overdue + expiry reminders via push (FR-14.1 push channel).
- [ ] Per-user notification preferences (FR-14.3) — channel + quiet-hours per user.
- [ ] i18n both languages; tests updated.

---

## F7 · Multi-site & per-role visibility  · (Wave 3, run carefully — RLS-invasive) branch `claude/fleetwise-multisite` · migrations 0270–0279
Covers FR-1.5, FR-2.3. Run **without** other RLS-touching agents in the same wave.

- [ ] Introduce an account/organisation layer or a `user_farm_memberships` table so one account can own **multiple farms/sites** with per-site isolation preserved; rewrite `app.accessible_farm_ids()` / `app.has_farm_access()` accordingly (keep the isolation tests green + extend them).
- [ ] Site switcher in the app shell; dashboards/reports filter per-site (completes FR-11.3).
- [ ] **Per-role visibility (FR-2.3):** operators see only assigned assets (`assigned_operator_id`), contractors see only assigned jobs — enforce via RLS predicates, not just UI.
- [ ] Extensive isolation-test additions for the new access paths.

---

## F8 · POPIA, security & backup  · (Wave 3) branch `claude/fleetwise-popia-security` · migrations 0280–0289
Covers NFR-2, NFR-3, NFR-4.

- [ ] `docs/POPIA.md` — personal/driver-data inventory, documented retention & deletion policy; a **data-subject deletion/export** RPC + admin flow (respecting audit/soft-delete).
- [ ] `docs/SECURITY.md` — verify + document encryption in transit/at rest, credential hashing (Supabase config), service-role key handling, RLS as the isolation guarantor.
- [ ] `docs/BACKUP.md` — documented backup + restore runbook + uptime target.
- [ ] Verify Supabase project settings match the documented posture.

---

## Deferred (pending `FLEETWISE_PROVIDER_RESEARCH_PROMPT.md` results)
- **Voice AI assistant** (FR-12) — build once STT/NLU/TTS provider (or custom-build decision) is chosen; reuse existing `createFault`/`addReading`/`createJobCard` actions + permissions; EN/AF; confirm-before-commit; offline fallback.
- **WhatsApp capture & reminders** (FR-16.1/16.2) — build once BSP is chosen; inbound webhook (service-role, signature-verified) resolving asset+user; outbound reminders mapping `notifications` rows with `channel='whatsapp'`.
- **Billing/payments** (FR-19.1 payments, FR-19.3) — wire the chosen payment provider into the F5 entitlement framework.
