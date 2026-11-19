# FLEETWISE final development: requirement register

Started 13 November 2026 by lane A (task A1). Sources: the BRIEF
(`C:\projects\output\Fleetwise-Claude-Final-Development-Prompt.md`, "S" = its section), the
decision register (`C:\projects\output\fleetwise-launch-decisions.md`, "D" = decision 1 to
41), the approved October pricing document, and the code at `6e3830a` (branch
`final/lane-a`). Owners are the tasks of `MASTER-PLAN.md` section 3. Scenarios ("Sc") are
the BRIEF's section 23 numbers.

States: **E** existing and verified (by reading code and its tests), **C** existing but needs
changes, **M** missing, **X** implemented locally, awaiting external verification, **EX**
excluded from the current offer. Workers update the State column of their own rows when they
finish; a row's ID never changes. "Code today" is the code found at `6e3830a`; **E (A1)** means
task A1 built it (migrations `20261114090000` to `20261114090300`, see
`docs/final-dev/REPORT-A1.md`) and it passed locally (unit tests and PGlite); CI on real
Postgres confirms it on merge. A state in brackets names what another task still owes.

## 1. Requirements

### Customer model and pricing (S4)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-001 | Full space R49/R79/R99 monthly | S4, D carried | `src/lib/entitlements.ts` PLAN_PRICING; `billing_price_versions` launch-2026-11 (20261104200000) | E | A1 | Sc1 |
| R-002 | Annual R490/R790/R990 as explicit annual cents, not derived from monthly | S4, D7 | annual = monthly x `months_charged` 10 (`ANNUAL_MONTHS_CHARGED`, generator in 20261104200000) | E (A1) | A1 | calculator.test.ts, safety.test.ts, billing_subscription.sql (0) |
| R-003 | Minimum 5 full spaces per customer subscription | S4 | `min_billed_slots` 5; signup, quota and plan quotes | E | A1 | Sc2 |
| R-004 | Included equipment 2/5/15 once per customer subscription | S4, D2, D22 | none | E (A1) | A1 | asset_capacity.sql [1] [3], calculator.test.ts |
| R-005 | Extra equipment R15 monthly, R150 annual | S4, D7 | none | E (A1) | A1 | asset_capacity.sql [1], calculator.test.ts |
| R-006 | Renewal formula F x rate + max(0, E - A) x equipment rate; four monthly fixtures and annual equivalents | S4 | none | E (A1) | A1 | Sc1: asset_capacity.sql [1], calculator.test.ts, view.test.ts |
| R-007 | Purchased full capacity distinct from active full-asset count; retiring frees a space, does not reduce the purchase | S4, D27 | `asset_quota` vs `app.billable_asset_count` (20260910230000) | E (A1) | A1 | Sc5: asset_capacity.sql [5] |
| R-008 | Equipment counted as a quantity (no per-item free/paid label) | S4, D-pricing | none | E (A1) | A1 | asset_capacity.sql [5], calculator.test.ts |
| R-009 | Self-service 5 to 200 full spaces; 201+ routed to capacity check and quote; not a combined equipment cap | S4, D39 | signup picker clamps 5..200 (`src/app/(public)/signup/plan-picker.tsx`); server has no ceiling | E (A2; website part A5) | A1 (rule), A2 (signup route) | Sc2: calculator.test.ts signupRoute, asset_capacity.sql [2], billing_signup_capacity.sql, billing_change_quotes.sql [39] |
| R-010 | One plan across a customer's sites; capacity, allowance, storage and budget pooled once; no grouping inferred from email | S4, D2, D22 | `farms.billed_through` main-site grouping (20261107150000) | E (A1 equipment and full; A3 storage pool, assistance budget, usage invoice) | A1 (equipment), A3 (storage, budget) | Sc3: asset_capacity.sql [3], storage_pool.sql, assistance_cap.sql [31], storage_blocks.sql [usage] |
| R-011 | Lowest-total plan that supplies the needed features is recommended; never auto-switch | S4 | none | E (A1) | A1 | calculator.test.ts comparePlans; previews list every plan |
| R-012 | Money in integer cents; snapshot currency, tax, prices, contract version; issued invoices immutable; old prices pinned | S4 | `billing_freeze_invoice`, `billing_freeze_price_version`, `billing_price_for_subscription` | E (A1) | A1 (new version), A2 | billing_subscription.sql (0), asset_capacity.sql [5] |
| R-013 | Check seller VAT status before touching tax; not VAT registered today | S4 | `billing_settings.vat_registered` false, `app.billing_force_vat_rate` | E | A1 | billing_subscription.sql (h3) |
| R-014 | Essential/Professional: individually authorised sites; Complete adds consolidated reporting; site switching not gated | S4, S7 | `multi_site` gate on `/sites`; site switcher ungated | E | A1 | Sc18 |

### Assets and the Support Equipment category (S5)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-020 | Fleet Assets and Support Equipment views under Assets, one asset identity and history | S5, D-eng | `/machines` list only | E (A1) | A1 | Sc9; machines list ?view=equipment (not browser-tested) |
| R-021 | Physical type, management/billing profile, site and lifecycle status kept separate | S5 | type + status on `machines`; no profile | E (A1) | A1 | equipment_profile.sql |
| R-022 | Eligibility by type in one place used by SQL and TS (eligible: pumps, generators, compressors, workshop tools, unpowered attachments, trailers; never: self-propelled vehicles) | S5, D1, D4 | `src/lib/machine-options.ts` types only | E (A1) | A1 | machine-options.test.ts, equipment_profile.sql |
| R-023 | Equipment entry needs a type and make/model where known; photo and serial optional | S5, D5 | add form (`src/app/(app)/machines/new`) | E (A1) | A1 | add page ?profile=equipment, csv.test.ts |
| R-024 | Human-review path for unusual classifications; no automatic billing from a photo | S5, D5 | none | E (A1) | A1 | equipment_profile.sql (review list) |
| R-025 | Equipment profile capabilities: identification, photo, site/location, hours, reminders, faults, inspections, repair jobs and costs, documents, QR, sale/warranty packs | S5, D3 | all core features ungated | E (A1) | A1 | Sc16: equipment_restrictions.sql |
| R-026 | Equipment refused on every plan: driver workflow, own trips, tracking, road licensing, fuel-use analysis, TCO, depreciation, loan/lease, budgets, detailed tyres | S5, D3, D33 | none | E (A1) | A1 | Sc14: equipment_restrictions.sql |
| R-027 | Trailer on the equipment profile may be referenced by a full vehicle's trip without gaining any refused tool | S5, D32 | `trips.trailer_id`, `second_trailer_id` | E (A1) | A1 | Sc15: equipment_restrictions.sql |
| R-028 | Eligible equipment may take the full profile; vehicles never take the equipment profile | S5, D1, D27 | none | E (A1) | A1 | equipment_profile.sql, asset_capacity.sql [9] |
| R-029 | Conversion keeps identity, documents, history; previews extra capacity and current/renewal totals; audited | S5, D27 | none | E (A1, A2: the space bought today is priced, bought through a quote) | A1 (preview, convert), A2 (proration) | Sc9: asset_capacity.sql [9] |
| R-030 | Retiring equipment stops its extra charge at next renewal; no current-period refund; history kept | S5, D6 | `retired` excluded from `billable_asset_count` | E (A1) | A1 (count), A2 (renewal) | Sc5: asset_capacity.sql [5] |
| R-031 | Restore needs available capacity; no archive/restore cycling to dodge fees or charge twice; no new work on retired equipment | S5, D6 | `returnMachineToService` (out_of_service only); quota trigger | E (A1) | A1 | Sc4, Sc5: asset_capacity.sql [4] [5] |
| R-032 | Transfers within a customer do not consume capacity twice; cross-customer handover explicit | S5 | `move_machine_to_site` (20261107110000) | C (A1 capacity; A6 handover audit) | A1 (capacity), A6 (handover audit) | Sc4: asset_capacity.sql [4] |
| R-033 | Existing assets default to full; no automatic reclassification or repricing; read-only migration preview of candidates | S24 | none | E (A1) | A1 | equipment_profile.sql, asset_capacity.sql (migration preview) |
| R-034 | Company reports keep equipment maintenance spend as a labelled subtotal; equipment excluded from TCO/fuel/depreciation analytics | S5, D-eng | reports in `src/app/(app)/reports` | E (A1) | A1 | reports/data.test.ts |

### Plan and permission enforcement (S6, S7)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-040 | One central matrix plan x profile x feature in TS mirrored in SQL | S6 | `FEATURE_MIN_PLAN` + `app.feature_min_rank` (0251) | E (A1) | A1 | entitlements.test.ts (pinned to 20261114090200) |
| R-041 | Profile check on every server path: pages, actions, API, RPC, policies, imports, offline sync, exports, jobs, assistant, WhatsApp, partner links, public API | S6, D19 | none for profile | E (A1) at the table; B4 assistant and WhatsApp wording | A1 (DB rules), B4 (assistant/WhatsApp wording) | Sc14: equipment_restrictions.sql |
| R-042 | Essential keeps job costs, parts/labour lines, finance documents, repair records, core tyres and loan/lease for full assets | S6, D33 | `can_view_farm_costs`, `can_view_farm_finance` ungated by plan | E | A1 | Sc16: equipment_restrictions.sql |
| R-043 | Budgets, TCO, depreciation on Professional+ for full assets | S6, S7, D33 | `tco` gate (PLAN_FEATURES.md) | E (A1) | A1 | Sc16: equipment_restrictions.sql |
| R-044 | Driving log, km readings, destination, written ordered stops on every plan | S8, D16 | `/driver/activity`, `driving_sessions`/`driving_events` | E (A1 key; Codex manual workflow reviewed; B3 verified; device run pending) | A1 (key), B3 (workflow) | equipment_restrictions.sql; manual_driving.sql; REPORT-B3-DRIVING.md |
| R-045 | Trip scheduling, assignments, trailer reference, delivery evidence, trip finance on Professional and Complete | S8, D16 | trips by plan on pages, actions and tables; history after a downgrade; driver must be on the business (20261119090000) | E (B3; browser walk pending) | A1 (gate), B3 (workflow) | Sc13: trips_by_plan.sql [13]; equipment_restrictions.sql; trips.test.ts |
| R-046 | Maps, route planning, reported locations, driving paths on Complete only, plus readiness flag; gate provider calls and writes | S8, D18 | `mapsAvailable` on screens and provider routes; `app.require_maps_ready` on route and position writes; POD location only with maps (20261119090000) | E (B3; maps stay unreleased: provider terms blocker in ROUTING.md) | A1 (gate), B3 (provider paths) | Sc13: trips_by_plan.sql, map_features.sql, trip_routes.sql, map-data.test.ts |
| R-047 | Sale and warranty packs every plan for both profiles; financial section obeys plan/profile/cost permission | S7, D33 | `/api/packs/machine/[id]/sale`, `warranty` (tco on cost section) | E (A1) | A1 | pack-data machineAllows |
| R-048 | General chat on every plan (feature key defined here, built by B2) | S14, D20 | `/chat`, `general_chat` readiness and staff membership gate | X (B2 isolated; Claude review and live checks pending) | A1 (key), B2 | Sc19; REPORT-B2.md |
| R-049 | Costs not globally hidden on Essential | S6 | cost visibility by role only | E | A1 | Sc16 |
| R-050 | Resource-site roles authoritative; billing authority grants no operational access | S6 | `app.effective_farm_role`, `is_farm_billing_admin` | E | A6 | Sc18 |
| R-051 | Downgrade keeps read/export of saved higher-tier records; no new premium computation | S6, D37 | trips, fuel, fines readable; positions as text and CSV; export holds trips/routes/positions; AARTO reminders by plan; offline fuel replay asks the plan (20261119090000, 100000, 130000) | E (B3; budgets/TCO/depreciation records via export only) | B3 | Sc17: trips_by_plan.sql [17], scheduled_work_by_plan.sql, offline_capture_once.sql, export route.test.ts; PLAN_FEATURES.md "After a downgrade" |
| R-052 | Professional/Complete catalogue (fuel, bowsers, fuel-card CSV, TCO, budgets, depreciation, reports, dashboards, scheduled reports, accounting exports, fleet packs) | S7 | gates `fuel`, `tco`, `dashboard`, `advanced_reports` | E | A1 | Sc16 |
| R-053 | Complete: consolidated sites, AARTO, AI/voice/WhatsApp eligibility, maps once verified | S7 | `multi_site`, `aarto`, `voice_ai`, `whatsapp` | C | A1 (maps key) | Sc13 |
| R-054 | Precise legal wording: no certified compliance, insurer approval or certification claims | S7, D17 | `src/lib/legal.ts`, help copy | C | A5 | review |

### Driving, trips, routes, Android (S8)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-060 | Manual driving workflows survive routing or geocoding failure; no map required for written stops | S8 | written stops save with no coordinates; trips and loads need no route service; planner errors are its own | E (B3) | B3 | Sc13: manual_driving.sql, trips_by_plan.sql [13]; Sc35 web part |
| R-061 | Trip finance: provenance, units, no duplicated job/fuel costs, honest zero/missing handling | S8 | `tripReport` (src/lib/trips.ts): finished trips only, per-km from trips with both readings, unknown income said, window said; trip result on the phone | E (B3) | B3 | Sc13: trips.test.ts |
| R-062 | Provider terms, quotas, attribution, global geocoding throttle rechecked | S8 | `docs/ROUTING.md` "Provider terms rechecked, 18 November 2026"; `place_search_slot` unchanged | X (B3; Mapbox route storage question is a founder/legal read before maps release) | B3 | Sc35: place_search.sql; ROUTING.md citations |
| R-063 | Android wrapper with background location, permissions, foreground service, queue, deep links | S8 | none (no Capacitor) | M | B6 | Sc35 |
| R-064 | External tracker ingestion stays Done-For-You and quoted | S8 | `ingest_tracker_positions`, `configure_driver_connection` plan check; a feed after a downgrade is refused (`maps_unavailable`) | E (B3) | B3 | Sc35: trip_routes.sql, trips_by_plan.sql |

### Limits, uploads, storage (S9, S10, S11)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-070 | One limits catalogue (commercial, abuse, provider, display windows) | S9 | constants scattered (see I-040) | M | B1 | Sc21 |
| R-071 | Photo 20 MB, PDF 50 MB, voice note 10 min / 20 MB, command 10 min, no video, decimal bytes | S9, D8 to D12 | 6/8 MiB photos and documents, 2,000,000-byte transcription, WhatsApp 6/4 MiB | C | B1 | Sc21, Sc22 |
| R-072 | Upload intent, quota reservation, direct resumable upload, server validation, finalisation | S10 | uploads pass through server actions and `/api/documents/upload` | M | B1 | Sc23 |
| R-073 | Photo compression with keep-original; PDFs unchanged | S10, D13 | client-side compression on machine photos only | C | B1 | Sc27 |
| R-074 | Completed command audio removed; unfinished recoverable; attached evidence retained | S10, D13 | `offline-voice-retention` | C | B1 | Sc28 |
| R-075 | Pooled storage max(2 GB, 100 MB x F + 25 MB x equipment spaces) + 10 GB blocks | S11, D14 | `usage_for_month` bills all bytes at cost plus markup | E (A3) | A3 | Sc24: storage_pool.sql [24], storage-allowance.test.ts |
| R-076 | Warn 80/95%, block only new attachments at full; drafts kept | S11, D15 | none | E (A3; no browser walk) | A3 | Sc25: storage_pool.sql [25], upload/server.test.ts |
| R-077 | Auto storage blocks OFF by default, owner monthly rand ceiling, transactional | S11, D34 | none | E (A3) | A3 | Sc26: storage_pool.sql [26], storage_blocks.sql [26] |
| R-078 | No automatic transfer overage bills; old R3/GB retired | S11, D36 | `usage_rates` has no transfer rate | E (A3: cost-plus storage invoices removed too) | A3 | Sc26: storage_blocks.sql [meter], usage-billing.test.ts |

### AI, voice, WhatsApp, chat (S12, S13, S14)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-080 | One customer-wide monthly rand cap for AI, voice, paid WhatsApp; owner sets it; no R200 default; blank is not unlimited | S12, D23 | per-farm `ai_default_limit_cents` 20000 (20261004100000) | E (A3) | A3 | Sc30: assistance_cap.sql [30], [migrate] |
| R-081 | Reservation before paid work incl. 30% markup and in-flight work; settle; staff sublimits | S12 | AI ledger holds (`ai_reservations`) | E (A3) | A3 | Sc31: assistance_cap.sql [31] |
| R-082 | Free WhatsApp message R0; AI billed once; BYOK not rebilled | S12, D24 | `farm_ai_keys`, `usage_rates` | X (A3 built and tested; real Meta statuses unverified, B4) | A3 | Sc32: assistance_cap.sql [32], whatsapp/paid.test.ts, delivery.test.ts |
| R-083 | Invoice uniqueness per customer + period + category | S12, S15 | `billing_invoices_farm_period_uq`; usage invoices by `runOnce` | E (A2 subscription kinds; A3 usage: one usage invoice per customer per day, one storage charge per subscription and month, ledger rows stamped once; corrections as credit NOT built) | A2, A3 | Sc10: billing_payment_integrity.sql, storage_blocks.sql [12] |
| R-084 | Equipment assistance on Complete limited to permitted tasks; confirmation before writes | S12, D19 | `apply_assistant_proposal` (no profile check) | C | A1 (DB rule), B4 (assistant) | Sc36 |
| R-085 | WhatsApp text, reminders, photos, voice notes; sender verification, site context, replay protection, app upload link for oversized media; real-phone tests | S13, D21 | `src/lib/whatsapp/*`, 20261015175415, 20261104210000 | X | B4 | Sc33 |
| R-086 | Paid WhatsApp needs owner acceptance of charges and cap with timestamp/version | S13, D24 | none | X (A3 acceptance, gate and settlement built; B4 real-phone journeys) | B4, A3 | Sc33: assistance_cap.sql [32] |
| R-087 | General staff chat: direct and group, membership, pagination, retry, unread, attachments, partner isolation | S14, D20 | `chat_*`, `/api/chat`, B1 uploads; shared-job discussions retained | X (B2 isolated; Claude review and live checks pending) | B2 | Sc19, Sc34; staff_chat.sql, protocol/privacy tests, chat_ui_check.mjs; REPORT-B2.md |

### Billing lifecycle (S15)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-090 | Additions prorated to the renewal, acceptance before capacity; filling paid/included space free | S15, D25 | `billing_quota_change_quote` full slots only | E (A2) | A2 | Sc6: billing_change_quotes.sql, change.test.ts |
| R-091 | Upgrades immediate with remaining-period difference on the whole package incl. allowances; credit when lower | S15, D25 | `billing_plan_change_quote` (charge only, no credit) | E (A2) | A2 | Sc7: billing_change_quotes.sql, change.test.ts |
| R-092 | Downgrades and reductions at renewal, never below 5; pending change edit/cancel; revalidate | S15, D25, D27 | `pending_plan`, `pending_quota`, `apply_pending_plan_changes` | E (A2) | A2 | Sc8, Sc10: billing_change_quotes.sql |
| R-093 | Cancellation stops next renewal, access to paid-through date, no automatic refund | S15, D26 | `setCancellation`, `billing_close_cancellations` | E (A2; legal read of the terms is external) | A2 | Sc11: billing_lifecycle.sql |
| R-094 | Failed renewal: 7 days grace (no paid extras), then 90 days owner-only read/export | S15, D41, D38 | 7 days grace then suspended (`farm_billing_gate`) | E (A2) | A2 | Sc11, Sc40: billing_lifecycle.sql, pay_gate.sql, lifecycle.test.ts |
| R-095 | Reactivation without duplicate charge or replay | S15 | `billing_restore_after_payment` | E (A2) | A2 | Sc10, Sc11: billing_lifecycle.sql |
| R-096 | Paystack webhook authenticity, amount, currency, attempt and quote version | S15 | `src/lib/billing/webhook.ts` | E (A2: settle guards, quote bound through its invoice) | A2 | Sc10: billing_payment_integrity.sql, billing_change_quotes.sql, webhook.test.ts |

### Export, retention, deletion (S16)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-100 | Complete export of records and media, durable background job, manifest, checksums, private expiring links | S16, D35 | complete export job (20261120110000): records through the requester's session, authorised file inventory, ZIP parts with SHA-256, manifest, lease, retry, missing-file reasons, 10-minute signed links, 7-day keep, bounded cleanup, nightly and optional minute worker | E (A4; live Storage run open) | A4 | Sc29: complete_export.sql, farm-export/job.test.ts |
| R-101 | 90-day owner-only retrieval after paid period, then scheduled deletion with warnings, dry run, holds | S16, D38, D40 | retention schedules (20261120120000): dry run while off, warnings only when on, deletion at least 30 days after the first warning, holds, reactivation and payment-in-flight checks, deletion through `close_farm_permanently` with reason retention, deletion ledger; ships OFF | X (A4; founder switch and legal read) | A4 | Sc11, Sc29: retention_schedules.sql, retention.test.ts |
| R-102 | Exports never reveal private chat or restricted records | S16 | file list through `export_readable_files` (invoker: Storage RLS and the pay gate decide), records through the session; chat, command audio and archives excluded; missing files named by hash | E (A4) | A4 | Sc20: complete_export.sql [1] [2], job.test.ts, farm-export-files.test.ts |

### Further features (S17, S18)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-110 | Structured import staging with OCR adapter (Professional/Complete) behind readiness | S17 | `src/app/(app)/documents` text extraction for partner documents only | M | B5 | Sc44 |
| R-111 | Custom asset fields (Professional/Complete), never changing billing class | S17 | none | M | B5 | Sc44 |
| R-112 | Manuals Q&A on Complete with citations, isolation, shared budget | S17 | none | M | B5 | Sc44 |
| R-113 | Old roadmap entries classified with evidence | S17 | `docs/CORPORATE_FLEET_ROADMAP.md` | E | A1 | this file, section 3 |
| R-114 | Exclusions kept: video, equipment-only subscriptions, self-hosting, full white label, paid SLA, paid workshop subscriptions | S17 | none built | EX | all | n/a |
| R-115 | Done-For-You quoted from R170, R2,500 minimum; accepted-quote and service-order flows with scope, allowance, schedule | S18, D28, D29 | `done_for_you_quotes` extended (20261120100000): explicit period prices and total, terms, owner acceptance, landing at the renewal on a private price row, plan guard, end through A2's pending change, work and review log; legacy rows untouched | E (A4; no browser run) | A4 | Sc43: service_orders.sql [4] to [7], service-orders.test.ts |
| R-116 | Activation catalogue (clean setup R150/R750, document capture R300/R1,500, R500/h, training, QR kits conditional) | S18 | `billing_service_catalogue` rules as data; `service_orders` offered, accepted by the owner, invoiced once; no stacking of setup work; QR kits not orderable until a supplier quote is recorded and marked ready | E (A4; QR kits blocked on a supplier quote) | A4 | Sc43: service_orders.sql [1] to [3], service-orders.test.ts |
| R-117 | Support hours weekdays 08:00 to 17:00 SAST, first response one business day, not a paid SLA | S18, D30 | `support_settings`, `support_holidays` | E | A5 | copy review |

### Imports, offline, defects (S19)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-120 | Machine import: reading dates, null unknown readings, whole-year validation, counts agree, idempotent repeat | S19 | `csv.ts`: repeat of an unidentified row refused (`machineKey`); refusals said in words | E (B3) | B3 | Sc14: csv.test.ts |
| R-121 | Bulk import applies type validation, profile entitlements and atomic capacity reservation | S19 | slot check before insert + quota trigger | E (A1) | A1 | csv.test.ts, asset_capacity.sql [4] |
| R-122 | Repeat-tap gaps: work-request media id, assistant/transcribe/voice ids, activation attempt resume, contractor sync claim, service template uniqueness | S19 | work media claim; `respondOnce` for turn and transcribe (voice-session already claimed); checkout resumes an open attempt; sync claim verified; template once per machine (20261119110000, 120000) | E (B3) | B3 | Sc23: work/media route.test.ts, request-claim.test.ts, request-id.test.ts, checkout-cancel.test.ts, contractor sync.test.ts, request_claim_answers.sql, service_template_once.sql |
| R-123 | Offline envelopes share request ids with online attempts; recheck membership/profile/plan on reconnect | S19 | queued capture keeps the online request id; `apply_offline_capture_once`; refusals kept and explained (20261119130000) | E (B3; A1 profile rule in DB) | B3 (ids), A1 (profile rule in DB) | offline_capture_once.sql, envelope.test.ts, sync-refusal.test.ts, equipment_restrictions.sql |
| R-124 | Large exports and accounting summary aggregated in SQL, bounded | S19 | business export streamed page by page (50,000 a table); complete export in bounded steps and ZIP parts (A4); accounting summary in SQL (20261119140000) | E (B3, A4) | A4 | Sc42: journal_summary.sql, export route.test.ts, job.test.ts |
| R-125 | Weekly digest delivery, empty states, assistant suggested actions | S19 | digest once a week per open business with catch-up (20261119100000); teaching empty states; starters fill the box only | E (B3) | B3 | scheduled_work_by_plan.sql, starters.test.ts |

### Security, infrastructure, release (S20, S21, S24, S25)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-130 | Re-enumerate and audit callable SECURITY DEFINER functions (85 reported; 50 open after pay gate round) | S20 | `supabase/tests/pay_gate_functions.sql` | C | A6 | Sc37 |
| R-131 | RLS on every new table (chat, equipment, intents, exports, usage) | S20 | pay gate and fence suites | C | each owner, A6 audit | Sc37 |
| R-132 | Password recovery, invite, magic link, deep links, removed-member sessions | S20 | `src/app/(auth)`, `src/app/auth` | C | A6 | Sc38 |
| R-133 | Media backup pipeline and restore drill from a separate copy | S21 | `.github/workflows/file-copy.yml`, `docs/BACKUP.md` (secrets missing) | X | A6 | Sc39 |
| R-134 | Scheduler auth, locks, health checks, alerts; lifecycle stops scheduled writes | S21 | `/api/health`, `cron_runs`, `CRON_SECRET` | C (A2 lifecycle part E: billing_lifecycle.sql; A6 the rest) | A6, A2 | Sc40 |
| R-135 | Load tests on disposable/staging data only | S21 | none (no k6 scripts) | M | A6 | Sc42 |
| R-136 | Forward-only migrations, release sequence, rollback, migration preview, feature flags | S24 | `scripts/apply_pending.mjs`, `deploy_compatibility.sql` | C | A6 (A1 for equipment preview) | Sc37 |
| R-137 | Deliverables matrix, catalogue, billing examples, provider checklist, readiness status | S25 | none | M | A6 | n/a |

### Website, signup, copy (S22)

| ID | Requirement | Source | Code today | State | Owner | Test |
|---|---|---|---|---|---|---|
| R-140 | Website comparison table with equipment allowances, minimum, extra equipment price, annual totals, storage, assistance | S22 | website repo (not read in A1: lane access) | C | A5 | Sc41 |
| R-141 | Signup carries plan, period, full spaces and equipment, tamper-resistant; never activated from URL | S22 | `src/app/(public)/signup`, `app.create_pending_signup` | C (A2 server and app form E: billing_signup_capacity.sql; A5 website) | A2 (server), A5 (website) | Sc41 |
| R-142 | App pricing/help/legal copy, FAQ, renewal and cancellation text, limits source of truth, revised plan PDF | S22 | `src/lib/legal.ts`, help pages, `C:\projects\output\pdf\build_fleetwise_review.py` | C | A5 | Sc41 |
| R-143 | Customer guidance EN/AF for equipment, quotas, spending, chat, exports, payments, devices | S25.8 | help pages | M | A5 | review |

## 2. Decision register coverage (D1 to D41)

| D | Subject | Requirement IDs |
|---|---|---|
| 1 | Equipment kinds; vehicles stay full | R-022, R-028 |
| 2 | One allowance per customer | R-004, R-010 |
| 3 | Equipment capabilities and refusals | R-025, R-026 |
| 4 | Eligibility by kind, no value cutoff | R-022 |
| 5 | Type and make/model; optional photo/serial; human review | R-023, R-024 |
| 6 | Retirement stops extra charge at renewal; restore cannot bypass | R-030, R-031 |
| 7 | R150 annual extra equipment; annual from annual price | R-002, R-005 |
| 8 | Photos 20 MB | R-071 |
| 9 | PDFs 50 MB | R-071 |
| 10 | Voice notes 10 min / 20 MB | R-071 |
| 11 | Ten-minute commands | R-071, R-074 |
| 12 | No video; chat attachments | R-071, R-087, R-114 |
| 13 | Photo reduction, keep-original, command audio cleanup | R-073, R-074 |
| 14 | Pooled storage formula | R-075 |
| 15 | Warn, stop new uploads at full, optional paid increases | R-076, R-077 |
| 16 | Driving logs every plan; trips Professional+ | R-044, R-045 |
| 17 | Driver documents, incidents, claims, work/rest every plan | R-054, R-044 |
| 18 | Maps and tracking Complete only | R-046, R-053 |
| 19 | Equipment assistance on Complete within the profile | R-084, R-041 |
| 20 | All-plan general chat | R-048, R-087 |
| 21 | WhatsApp text, reminders, photos, voice | R-085 |
| 22 | One plan per customer; shared allowance, storage, budget | R-010 |
| 23 | Shared owner-set monthly cap | R-080, R-081 |
| 24 | WhatsApp owner acceptance; cost +30%; free messages R0 | R-082, R-086 |
| 25 | Proration, upgrades with credit, downgrades at renewal | R-090, R-091, R-092 |
| 26 | Cancellation policy | R-093 |
| 27 | Conversion with preview, minimum kept | R-029, R-007 |
| 28 | Staffing closed | R-115 |
| 29 | Done-For-You quote content | R-115 |
| 30 | Support hours and response target | R-117 |
| 31 | Verified core launch; hold back unfinished | R-136, R-140, R-142 (readiness flags) |
| 32 | Trailer reference on trips | R-027 |
| 33 | Tyre/finance/budget boundaries; packs; depreciation | R-026, R-042, R-043, R-047 |
| 34 | Auto storage ceiling | R-077 |
| 35 | Complete export with media | R-100 |
| 36 | No transfer overage bills | R-078 |
| 37 | Downgrade keeps old records | R-051 |
| 38 | 90-day owner retrieval | R-094, R-101 |
| 39 | 200-space signup ceiling | R-009 |
| 40 | Scheduled deletion after retrieval | R-101 |
| 41 | Seven-day grace | R-094 |

## 3. Inventory of open items, flags, placeholders and "not yet" claims

Each item is resolved as in scope (owner) or classified with evidence. "Founder" means a human
action outside the code; it stays in the founder's to-do list and blocks only what it names.

### docs/LAUNCH_CHECKLIST.md (unchecked boxes, line numbers at `6e3830a`)

| ID | Item | Resolution |
|---|---|---|
| I-001 | L20 real admin login team@ | Founder (account), no code |
| I-002 | L26 GitHub secret scanning and push protection | Founder (repository setting) |
| I-003 | L28 buy the domain | Founder; the app already runs at app.fleet-wise.co.za (checklist line 263) so the box is stale |
| I-004 | L30 `OPS_ALERT_EMAIL`, L44 `SENTRY_DSN` | Founder (Vercel settings); A6 verifies detection of missing configuration |
| I-005 | L37 external minute scheduler (cron-job.org) | Founder; A6 (scheduler checks) |
| I-006 | L42 uptime monitor | Founder; `/api/health` exists (E) |
| I-007 | L45 Resend domain, L47 Supabase SMTP, L52 domain in Vercel/Supabase | Founder |
| I-008 | L56 staging Supabase project | Founder; blocks A6 load tests (R-135) |
| I-009 | L59 Paystack test webhook URL, L99 Paystack live | Founder; A2 keeps test/live separate |
| I-010 | L62 Azure budget, L90 Azure S0, L94 AI Gateway credit | Founder (purchases); A3 provider-budget alerts |
| I-011 | L64 POPIA Information Officer, L67 lawyer read | Founder/legal; A5 prepares the legal-review checklist |
| I-012 | L70 media backup secrets | Founder; A6 (R-133) |
| I-013 | L76 D-U-N-S, L78 test phones | Founder; block B6 device tests and B4 real-phone tests |
| I-014 | L84 Vercel Pro, L87 Supabase Pro, L97 Resend Pro, L130 compute, L132 PITR | Founder purchases; A6 lists them in the provider checklist |
| I-015 | L106 to L113 final domain check, launch day | A6 release sequence |
| I-016 | L120 support phone, L122 election-day holiday | Founder; A5 copy uses the configured contact settings |
| I-017 | L133 "WhatsApp after launch; debit orders later" | WhatsApp superseded by D21 (B4). Debit orders: not in the BRIEF, classified EX for this round |
| I-018 | L176 taps release 2 follow-ups | B3 (R-122): closed |
| I-019 | L202 offline request id in envelope; sweep accounts in CI | B3 (R-123): closed; sweep accounts: A6 |
| I-020 | L209 export in memory, accounting summary in page | Closed by A4 (R-100, R-124): records stream (`47a8455`) and the complete export with files runs as a job in bounded parts (20261120110000) |
| I-021 | L261 H4 load test | A6 (R-135), blocked by I-008 |
| I-022 | L271 weekly digest, empty states, suggested questions | B3 (R-125): closed |
| I-023 | L335 activation catalogue as orders | Closed by A4 (R-116): `service_orders` (20261120100000) |
| I-024 | L356 map tiles and lawyer read of tracking wording | B3: flag `map` stays off; tiles need a production source (ROUTING.md); founder for the legal read |
| I-025 | L358 Android app | B6 (R-063), blocked by I-013 for store publication |
| I-026 | L360 media backup has no external copy | A6 (R-133), blocked by I-012 |
| I-027 | L363 definer audit, WebView needs, remaining "not yet" items | A6 (R-130), B6 (WebView), A1 (this inventory) |

### docs/PLAN_FEATURES.md

| ID | Item | Resolution |
|---|---|---|
| I-030 | "Attachment storage not metered or enforced" | Closed by A3 (R-075 to R-077, 20261118120000/120100) |
| I-031 | "Slots pooled across a customer's sites: not built" | Stale: built in 20261107150000 (`farms.billed_through`); A1 updates the doc and extends pooling to equipment |
| I-032 | "WhatsApp provider cost not metered" | A3: on the AI ledger under the spending limit with owner acceptance (20261118120200); off until Rapid Rise sets the start date and rates; real phones B4 |
| I-033 | "WhatsApp voice notes and photos built, not yet released" | B4 (R-085), X until real-phone tests |
| I-034 | "accepted-quote recording is open" | Closed by A4: offers, owner acceptance and landing at renewal on `done_for_you_quotes` (20261120100000) |
| I-035 | Fleet compliance pack placement (website Complete vs app Professional) | Professional, as S7 lists "fleet evidence packs" under Professional and Complete; A5 aligns the website |

### docs/ROUTING.md, BACKUP.md, WHATSAPP.md, AI_USAGE.md, BILLING.md

| ID | Item | Resolution |
|---|---|---|
| I-036 | ROUTING "Later: the own route server (OSRM)" | Classified: founder decision 2026-11-11, switch at about 1,000 trips/month; not a launch item; B3 rechecks provider terms (R-062) |
| I-037 | ROUTING map tiles must leave the free test service | B3: recorded in ROUTING.md "Provider terms rechecked"; founder chooses the source |
| I-038 | BACKUP restore drill and readiness checklists (§5 to §7) | A6 (R-133) |
| I-039 | WHATSAPP real-phone linking and messages unverified | B4 (R-085), blocked by I-013 |
| I-040 | Scattered media caps: `src/app/(app)/finance/actions.ts` 8 MiB, `src/app/(app)/trips/actions.ts` 8 MiB, `src/app/api/assistant/transcribe/route.ts` 2,000,000 bytes, `src/lib/whatsapp/media.ts` 6 MiB/4 MiB, `src/app/(app)/fuel/cards/actions.ts` 2 MiB (keep), admin proof 4 MiB | B1 (R-070, R-071) |
| I-041 | AI_USAGE "Not built yet": margin change with notice; monthly reconciliation | Still open after A3 (see REPORT-A3.md "Not done"): the ledger now records what a reconciliation needs |
| I-042 | AI_USAGE "Not built yet": daily canary call | A6 (health checks) |
| I-043 | AI_USAGE "Not built yet": Azure synthesis and recognition on the server | Classified: engineering improvement, not required by the BRIEF; B1 evaluates it for ten-minute commands |
| I-044 | BILLING §15b: a real Paystack decline never happened | A2 tests the path; a real decline needs live/test card behaviour (external) |
| I-045 | BILLING §11: `prorate_annual_additions` false | Superseded by D25 (prorate additions): A2 |
| I-046 | BILLING / CLAUDE.md: no Founding Farmer code | Classified EX: "no automatic founding-customer promotion" (S4) |
| I-047 | BILLING §11b: what a lost dispute does | Founder decision still open; not in the BRIEF; A2 records it as a decision |

### docs/CORPORATE_FLEET_ROADMAP.md (recommendations, not commitments)

| ID | Item | Resolution |
|---|---|---|
| I-050 | 1 Goods-vehicle compliance (COF, NRTA, DG, abnormal loads) | EX: speculative; not in the reviewed offer. Existing licence types cover permits generically |
| I-051 | 2 Trips, loads, proof of delivery, trailer pairing | In scope through D16 and D32: B3 (workflow, closed), A1 (trailer reference gate) |
| I-052 | 3 Telematics adapters | Done-For-You quoted per provider (S8); generic ingestion exists (`/api/integrations/*`); no adapter commissioned: EX until a customer commissions one |
| I-053 | 4 Fuel cards | E: built 20261107140000 (`fuel_card_statements`, CSV review, Professional) |
| I-054 | 5 Driver hours and fatigue | "Basic work/rest records" on every plan (D17): B3 verified `/trips/hours` is ungated and counts trips and driving logs once; fatigue policy engine EX |
| I-055 | 6 Approvals and purchasing | EX: speculative enterprise proposal (S17) |
| I-056 | 7 SSO and directory provisioning | EX (S17); two-step sign-in exists for staff and is offered to owners |
| I-057 | 8 Group billing above sites | E for full spaces (20261107150000); equipment pooling A1 |
| I-058 | 9 Pool vehicle bookings | EX (S17) |
| I-059 | 10 Emissions reports, BI connectors | EX (S17); utilisation/downtime reports exist under `advanced_reports` |
| I-060 | 11 Extra driver languages | EX: two languages (S17 lists extra languages as classify-only) |
| I-061 | Trucking add-on price idea (R40 to R60) | EX: not an approved price |

### Flags, placeholders and disabled flows in the code

| ID | Item | Resolution |
|---|---|---|
| I-070 | Feature flag `map` (`src/lib/features.ts`, `feature_flags`, `farm_feature_access`) | Kept as the maps readiness flag; A1 adds the Complete plan gate on top; B3 owns release |
| I-071 | `WHATSAPP_ENABLED` environment flag | B4; capability-specific flags until real-phone tests pass |
| I-072 | `BILLING_PROVIDER`, `BILLING_CHARGING_ENABLED` kill switch | E (BILLING §12) |
| I-073 | Turnstile env-gated (`src/lib/security/turnstile.ts`) | Founder sets keys (security round open item) |
| I-074 | `AI_KEY_SECRET` missing: BYOK refused | Founder (CLAUDE.md "Open, founder only") |
| I-075 | Done-For-You has no current price row: quote only | E by design (20261104200000) |
| I-076 | Code TODO/FIXME sweep | None found in `src` at `6e3830a` (grep for TODO, FIXME, "coming soon", "not yet built") |
| I-077 | Website `docs/COMMERCIAL.md`, `docs/FEATURE-SOURCES.md` | A5 inventories them (outside lane A1's read access) |
