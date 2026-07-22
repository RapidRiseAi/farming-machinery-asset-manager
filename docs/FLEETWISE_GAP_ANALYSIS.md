# FleetWise — Gap Analysis & Build Plan

**Audit date:** 2026-07-22
**Spec audited against:** *FleetWise Build Checklist & Functional Requirements v1.0* (Rapid Rise AI) — sections 1–24, requirements tagged `FR-x.y` / `NFR-n`, priorities P0/P1/P2. A copy of the source spec lives at [`docs/fleetwise-build-checklist.pdf`](./fleetwise-build-checklist.pdf).
**Codebase audited:** this repo — the **"FarmGear"** Next.js/Supabase app (app name `FarmGear`, package `farmgear`).
**Method:** read of every migration (`supabase/migrations/0001–0207`), every route/action under `src/app`, the shared libs, the RLS isolation suite, and the i18n dictionaries. No code was changed in this pass.

---

## 0. Headline

> **FarmGear is a well-built, tenant-isolated *maintenance & job-card* app. FleetWise is a much larger spec — fleet TCO, fuel, voice AI, WhatsApp, offline-first, AARTO compliance, and plan-gated billing. FarmGear implements roughly the maintenance/servicing core of FleetWise and almost none of the fleet-platform surface around it.**

The two products were scoped differently on purpose: FarmGear's own `docs/SCOPE.md` and `CLAUDE.md` explicitly list *offline sync, fuel features, voice, WhatsApp API, GPS/telemetry, invoicing/accounting, and parts inventory* as **out of v1 scope**. The FleetWise checklist marks most of those as **P0 launch-critical**. That mismatch is the entire story of this gap analysis.

**P0 scorecard: of 40 P0 requirements, ~11 are fully met, ~14 partial, ~15 missing.**

| Legend | Meaning |
|---|---|
| ✅ | Implemented and meets the acceptance criteria |
| 🟡 | Partial — exists but incomplete or divergent (file cited) |
| ❌ | Missing — no meaningful implementation |
| ❓ | Unclear from code |

---

## 1. Summary table — requirement → status → evidence

### §1 Product scope & principles
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-1.1 | P0 | ✅ | `machines` registry with 7-type enum; CRUD in `machines/actions.ts`, `0003_machines_and_readings.sql`. |
| FR-1.2 | P0 | 🟡 | Fault/reading capture are fast & mobile-first, but **fuel capture doesn't exist** and there is no <30s validation. |
| FR-1.3 | P0 | ❌ | **No offline capability.** `public/manifest.webmanifest` exists but there is **no service worker** (`grep serviceWorker` → none), no cache, no local queue. |
| FR-1.4 | P1 | 🟡 | `audit_log` trigger captures who + when + full diff (`0008`), but **not "from where"** (no IP/source/geo). |
| FR-1.5 | P0 | 🟡 | Per-farm isolation is real and tested (RLS). But there is **no Organisation→many-Farms** layer: a user has exactly one `farm_id` (`users` constraint, `0002`). No single account spanning multiple sites. |

### §2 Users & permissions
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-2.1 | P0 | 🟡 | Roles `owner/manager/mechanic/operator/workshop/rr_admin` (`0001`). No distinct **External Contractor** (workshop ≈ contractor); mapping is approximate. |
| FR-2.2 | P0 | ✅ | No per-user cap anywhere; invites unlimited (`team/actions.ts`). |
| FR-2.3 | P1 | ❌ | **Not enforced.** RLS grants every farm role access to the *whole* farm (`app.has_farm_access`, `0100`). Operators are **not** limited to assigned assets; `assigned_operator_id` is never used in a policy. Workshop sees the whole linked farm, not just assigned jobs. |
| FR-2.4 | P1 | 🟡 | Invite + activate/deactivate work (`team/actions.ts`). Least-privilege is coarse (role-level only). |
| FR-2.5 | P2 | ❌ | No custom roles / permission toggles. |

### §3 Asset register
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-3.1 | P0 | ✅ | Create/edit + archive-by-status (`retired`/`sold`) + soft delete. `machines/actions.ts`. |
| FR-3.2 | P0 | 🟡 | make/model/year/reg/serial(VIN)/purchase date+price/photos ✅; **finance details ❌** (`grep finance` → none in schema or UI). |
| FR-3.3 | P0 | 🟡 | Status enum is `active/in_workshop/standby/retired/sold` — divergent vocabulary; **no "Out of service"** and "In use/Available" are approximated by active/standby. |
| FR-3.4 | P1 | 🟡 | Filter by type/status + search + sort (`machines/page.tsx`). **No location / cost-centre / department** grouping (those fields largely don't exist). |
| FR-3.5 | P0 | ✅ | `current_reading` advanced on every reading + job completion (`app_meter_reading_after`, `app_jobcard_completed`, `0202`). |
| FR-3.6 | P1 | ❌ | `assigned_operator_id` column exists (`0003`) but there is **no UI to set it** (`MachineFields` omits it) and nothing reads it. Dead field. |
| FR-3.7 | P1 | ✅ | CSV bulk import with parse/validate/preview/template (`machines/import/csv.ts`, `importMachines`). |

### §4 Maintenance & servicing
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-4.1 | P0 | 🟡 | Job-card history (parts/labour/other) + faults + timeline ✅. **Fuel is not in history** (fuel tables dormant). |
| FR-4.2 | P0 | ✅ | `app.recalc_machine_service` evaluates hours/km **and** calendar months, earliest wins (`0202`). |
| FR-4.3 | P0 | ✅ | Recurring intervals per line (`service_plan_lines.interval_hours/interval_months`). |
| FR-4.4 | P0 | ✅ | OK/due-soon/overdue computed from latest reading + thresholds; meter trigger + nightly recompute. |
| FR-4.5 | P1 | 🟡 | Notes ✅ (diagnosis/work/recommendations). **Service/job-card photo upload ❌** — `jobcard-photos` bucket exists but the job-card page has no media UI (`jobcards/[id]/page.tsx` → "NO MEDIA"). |
| FR-4.6 | P1 | ✅ | Plan→in-progress→complete→approve/lock with `mechanic_user_id` (`jobcards/actions.ts`, lock trigger `0008`). |
| FR-4.7 | P2 | 🟡 | `warranty_expiry_date/hours` are editable but **not displayed** on the detail page and **no expiry reminders**. |

### §5 Service kits & parts
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-5.1 | P0 | ❌ | **No service-kit entity.** `service_plan_lines` are tasks (text + interval), not oil/filter part numbers. |
| FR-5.2 | P1 | ❌ | No parts catalogue; `part_no` is free text on a job line. |
| FR-5.3 | P1 | 🟡 | Job-card part lines roll into cost + history ✅, but there is no catalogue to consume from. |
| FR-5.4 | P2 | ❌ | No inventory / stock / low-stock. |

### §6 Fuel & consumables
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-6.1 | P0 | ❌ | Tables `fuel_tanks/deliveries/issues` exist (`0007`) but are **dormant — zero UI/features** (`grep fuel src` → none). |
| FR-6.2 | P0 | ❌ | No consumption (L/hr, L/100km) or trend computed. |
| FR-6.3 | P0 | ❌ | No fuel anomaly detection. |
| FR-6.4 | P2 | ❌ | No fuel-card import/reconcile. |

### §7 Fault & issue reporting
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-7.1 | P0 | ✅ | `FaultCapture`: description + urgency (severity) + photo + voice note; app + public QR paths. |
| FR-7.2 | P0 | 🟡 | asset/reporter/timestamp ✅; **location ❌** (no geolocation captured). |
| FR-7.3 | P1 | 🟡 | Status is `open/in_job/scheduled/resolved` — **not** Open→Acknowledged→In-progress→Resolved; **no assignee**. |
| FR-7.4 | P1 | ✅ | Fault → job card (`createJobCard` from `faults/page.tsx`), sets `created_from_fault_id`; completion auto-resolves the fault (`0202`). |
| FR-7.5 | P1 | ❌ | Reporting a fault **does not** flip asset status to Out of service (no such code). |

### §8 Contractor & mechanic portal
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-8.1 | P0 | 🟡 | Workshop role + `workshop_links` give farm-scoped access (tested), but **not limited to assigned jobs** — the whole farm is visible. |
| FR-8.2 | P0 | ❌ | **No quote/invoice/job-photo upload UI** on job cards (bucket exists, unused). |
| FR-8.3 | P1 | 🟡 | Status updates work; `job_completed` notification fires. No generic "status changed" notify. |
| FR-8.4 | P1 | 🟡 | Job-card line totals flow to cost, but there is **no invoice-amount capture** and **no TCO to flow into**. |

### §9 QR codes & field capture
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-9.1 | P0 | ✅ | Unguessable `public_token` per machine; QR print sheet at `/machines/[id]/qr`; `qrcode` dep. |
| FR-9.2 | P0 | 🟡 | Scan opens the asset and offers **report fault + log reading**. **No "log service" and no "log fuel"** quick actions (`m/[token]/page.tsx`). |
| FR-9.3 | P1 | ❌ | No offline scan-to-log (no offline at all). |
| FR-9.4 | P2 | ❌ | No re-issue/replace-QR flow. |

### §10 Costs & TCO
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-10.1 | P0 | 🟡 | parts/labour/other via job cards ✅. **fuel + finance/interest ❌**; no distinct invoice cost type. There is **no unified `CostEntry`** table — costs live only inside `job_card_lines`. |
| FR-10.2 | P0 | ❌ | **TCO not computed.** "Total spend" = sum of job-card totals only (`machines/[id]/page.tsx`, `reports/data.ts`). No purchase price, finance, or fuel included. |
| FR-10.3 | P0 | 🟡 | Cost/hour = maintenance ÷ lifetime hours (displayed). **No cost/km.** See divergence D-2 (period ÷ lifetime mismatch in reports). |
| FR-10.4 | P1 | ❌ | No budgets / budget-vs-actual (`grep budget` → none). |
| FR-10.5 | P2 | ❌ | No repair-vs-replace indicator. |

### §11 Dashboard & reporting
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-11.1 | P0 | ✅ | Dashboard: due/overdue KPIs, spend this/last month + 6-mo trend, assets, cost-by-machine (`dashboard/page.tsx`). |
| FR-11.2 | P0 | 🟡 | "Recurring problems" = top part-descriptions + top fault-categories counts (`reports/data.ts`). **Not** true per-machine repeat-repair ranking. |
| FR-11.3 | P1 | 🟡 | Period presets + custom range ✅. **No per-site/per-group filter.** |
| FR-11.4 | P1 | 🟡 | CSV per family ✅; job-card & machine-file **PDF** ✅ (`pdf-lib`); report PDF is browser-print; **no Excel**. |
| FR-11.5 | P2 | ❌ | No scheduled/emailed reports. |

### §12 Voice control AI assistant
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-12.1 | P0 | ❌ | **No voice control.** The only "voice" is a fault **audio-note attachment** (`fault-media.ts`) — not speech recognition or command parsing. |
| FR-12.2 | P1 | ❌ | n/a — no assistant. |
| FR-12.3 | P1 | ❌ | n/a. |
| FR-12.4 | P2 | ❌ | n/a. |

### §13 Compliance (AARTO, audits, docs)
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-13.1 | P0 | ❌ | **No driver-usage log.** `meter_readings.by_user` is not a driver-operated-vehicle record; no `UsageLog` (`grep aarto` → none). |
| FR-13.2 | P1 | ❌ | No AARTO fine workflow. |
| FR-13.3 | P1 | ❌ | No licence/renewal tracking or reminders. |
| FR-13.4 | P1 | ❌ | No GLOBALG.A.P./SIZA audit pack or sale/warranty document packs (machine-file PDF is a service book, not these). |

### §14 Notifications & reminders
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-14.1 | P0 | 🟡 | **In-app** service-due/overdue/stale/weekly engine ✅ (`0205`, nightly cron). **Push ❌, WhatsApp ❌, licence-expiry ❌.** |
| FR-14.2 | P1 | 🟡 | Fault-reported ✅ + job-completed ✅ (`0203`). **Fuel anomaly ❌**; no generic status-change notify. |
| FR-14.3 | P2 | 🟡 | Quiet hours ✅ (farm-level, `quiet_deliver_after`). **Per-user preferences ❌.** |

### §15 Offline & sync
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-15.1 | P0 | ❌ | No offline capture / local queue. |
| FR-15.2 | P0 | ❌ | No sync engine / sync status UI. |
| FR-15.3 | P0 | ❌ | No conflict resolution; **no `SyncQueue`** entity. |
| FR-15.4 | P1 | ❌ | No offline media cache. |

> Note: the job-card editor's `localStorage` "draft restore" (`job-card-editor.tsx`) is a single-form UX nicety, **not** an offline-sync layer.

### §16 WhatsApp & mobile capture
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-16.1 | P0 | ❌ | **No WhatsApp integration.** `notification_channel`/`meter_source` enums include `whatsapp`, but there is no inbound webhook or outbound BSP client. |
| FR-16.2 | P1 | ❌ | No WhatsApp reminders/confirmations. |
| FR-16.3 | P0 | ✅ | Mobile-first, responsive Tailwind, ≥44–48px touch targets (`min-h-[48px]`), low-bundle (~102 kB). |

### §17 Integrations & API
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-17.1 | P1 | ❌ | No fuel-card import; no GPS/telematics feed. |
| FR-17.2 | P2 | ❌ | No Sage/Xero export. |
| FR-17.3 | P2 | ❌ | No public REST API / token auth. |

### §18 Localisation (EN/AF)
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-18.1 | P0 | 🟡 | EN/AF dictionaries at **full parity (429/429 keys, 0 missing)** ✅; language persisted per user (`users.language`). **But no self-service per-user language switcher** (set at invite or farm default only); the RR-admin console is English-only. |
| FR-18.2 | P1 | ✅ | Rand formatting (`rands()`), `en-ZA` dates, hours/km units. |

### §19 Billing, plans & entitlements
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| FR-19.1 | P0 | ❌ | Tiers are `starter/standard/large` — **not** Essential/Professional/Complete/Done-For-You. **No billing, no per-vehicle-per-month pricing, no payment** anywhere. |
| FR-19.2 | P0 | ❌ | **No entitlement gating.** `tier` is stored/editable (`admin/farms/[id]`) but **gates no feature** — dashboard/voice/AARTO are not behind any plan check. |
| FR-19.3 | P1 | ❌ | No annual pre-pay / asset-count pricing / export-on-cancel (machine CSV export is the only "export"). |
| FR-19.4 | P2 | ❌ | No self-hosted licence path. |

### §22 Non-functional
| ID | P | Status | Evidence / gap |
|---|---|---|---|
| NFR-1 | P0 | 🟡 | Lean bundle, but dashboard/reports **load all rows and aggregate in JS with no pagination** (`dashboard/page.tsx`, `reports/data.ts`); no measured 3G budget. |
| NFR-2 | P0 | 🟡 | **Per-tenant isolation is genuinely proven** by `rls_isolation.sql` (cross-tenant read/write denial, workshop scoping, anon-deny, link revocation) ✅. Transit/at-rest encryption + hashed creds are inherited from Supabase but **not documented/verified here**. |
| NFR-3 | P0 | ❌ | **No POPIA artefacts** — soft-delete columns exist, but no documented retention/deletion policy and no data-subject deletion flow. |
| NFR-4 | P1 | ❌ | No documented backup/restore or uptime target. |
| NFR-5 | P1 | 🟡 | Large tap targets + focus rings ✅; high-contrast/sunlight mode and full screen-reader labelling unverified. |
| NFR-6 | P1 | ❌ | No error logging / sync-failure alerts / usage analytics (cron returns a status object only). |
| NFR-7 | P1 | 🟡 | Good indexes; but the JS-side "load everything" dashboards/reports will degrade well before "thousands of assets". |

### §23 Metrics — computed correctly?
| Metric | Status | Evidence / gap |
|---|---|---|
| Machines due/overdue | ✅ | `service_plan_lines.status` counts, dashboard + compliance report. |
| Total maintenance spend (period) | ✅ | Sum of job-card totals in range (`reports/data.ts`, dashboard trend). |
| Number of assets tracked | ✅ | Active-machine count. |
| Cost by machine (ranked) | ✅ | `costPerMachine` sorted desc. |
| Parts/machines break most often | 🟡 | Counts part **descriptions** & fault **categories**, not per-machine repeat repairs. |
| **TCO per asset** | ❌ | Maintenance only — excludes purchase, finance, fuel. |
| **Cost per engine hour** | 🟡 | See D-2: numerator is period-filtered spend, denominator is lifetime hours → mismatched. |
| **Cost per kilometre** | ❌ | `perHour` only for `meter_type='hours'`; no km path. |
| Fuel consumption (L/hr, L/100km) & trend | ❌ | Fuel dormant. |
| Fuel anomalies | ❌ | None. |
| Downtime per asset | 🟡 | Only "days in workshop" via earliest open job card `date_in` (proxy), not true downtime. |
| Open vs resolved faults | 🟡 | Dashboard shows open; no explicit open-vs-resolved metric. |
| Budget vs actual | ❌ | No budgets. |
| Utilisation (hours used vs idle) | ❌ | Not computed. |
| Warranty/licence expiries upcoming | ❌ | Warranty fields exist but no "upcoming expiry" metric; no licences at all. |
| AARTO nominations pending & deadlines | ❌ | No AARTO. |

---

## 2. Prioritised remaining-work list (tickets)

Ordered **all P0 gaps first**. Each ticket has acceptance criteria and the files/areas to touch. "New" = area doesn't exist yet.

### P0 tickets

**T1 — Offline-first capture + sync queue + conflict resolution** *(FR-1.3, FR-15.1–15.3, FR-9.3; §20 flow; §24)*
- **Why:** Multiple P0s and the §24 gate hinge on this. Today there is zero offline support.
- **Acceptance:** (a) Reading/fault/job capture succeed with network disabled and are queued locally (IndexedDB). (b) A registered service worker caches the app shell + last-viewed asset data. (c) On reconnect, queued mutations flush automatically with a visible sync-status indicator. (d) Conflicts resolve deterministically (last-writer-wins + an `audit_log` entry per applied mutation) with **no silent loss**; a forced conflict test passes. (e) Dependent metrics recompute after flush.
- **Touch:** new `public/sw.js` + registration in `src/app/layout.tsx`; new client sync lib (`src/lib/offline/*`) using IndexedDB; new `sync_queue` table + migration; service-role flush endpoint under `src/app/api/sync/`; `next.config.mjs` (SW headers). Add offline cases to a new test suite.

**T2 — Fuel module (log, consumption, anomaly) end-to-end** *(FR-6.1–6.3; feeds FR-10.x, §23; §20 flow)*
- **Acceptance:** (a) Log fuel per asset (litres, cost, date, meter, operator) from app + QR. (b) L/hr and L/100km + per-asset trend computed and shown. (c) Entries deviating from an asset's rolling baseline are flagged (leak/theft) and notify (FR-14.2). (d) Fuel cost appears in the asset cost record.
- **Touch:** tables already exist (`0007`) — build UI (`src/app/(app)/fuel/*`), server actions, QR quick action (`m/[token]`), a consumption/anomaly SQL function (new migration), dashboard/report widgets, `fuel_reported`/`fuel_anomaly` notification templates (`0205` pattern).

**T3 — True Cost of Ownership + unified CostEntry + cost/hr & cost/km** *(FR-10.1–10.3, FR-8.4; §23 TCO/cost-per-hour/cost-per-km; §20 flow)*
- **Acceptance:** (a) A single cost rollup per asset = purchase + finance + fuel + parts + labour + external invoices. (b) TCO shown on asset detail and ranked in reports. (c) Cost/engine-hour and cost/km both computed against the **same period basis** as the numerator (fix D-2). (d) A contractor invoice amount recorded against an asset increments its TCO.
- **Touch:** new `cost_entries` table + migration (type = fuel/parts/labour/invoice/finance) with triggers that append from job-card lines and fuel issues; add `finance_*` fields to `machines`; rewrite `reports/data.ts` cost math + `machines/[id]/page.tsx` lifetime stats.

**T4 — Voice control assistant (EN/AF) to log & query hands-free** *(FR-12.1; §20 flow; §24)*
- **Acceptance:** (a) Voice command in EN and AF can log a service/fault and query asset status. (b) The assistant confirms the parsed action and prompts for missing fields before committing (FR-12.2). (c) Voice goes through the same server actions/permissions/validation as manual entry (FR-12.3) — i.e. a voice-logged fault creates the **same** `faults` row a QR/app fault does. (d) Graceful fallback to manual on failure/offline (FR-12.4).
- **Touch:** new `src/app/(app)/assistant/*` + a client capture component; STT provider integration (server route); an intent→action mapper that calls existing `createFault`/`addReading`/`createJobCard`; permission reuse via `requireRole`.

**T5 — WhatsApp inbound capture + outbound reminders (BSP)** *(FR-16.1, FR-16.2, FR-14.1 WhatsApp channel; §20 flow)*
- **Acceptance:** (a) A WhatsApp message logs a service/fault, resolving to the correct asset (token/registration) and user (phone → `users.phone`), creating the **same** underlying records. (b) Service-due/overdue reminders and confirmations are delivered over WhatsApp and reference the same rows as in-app. (c) Opt-in respected (`users.whatsapp_opt_in`).
- **Touch:** new inbound webhook `src/app/api/whatsapp/route.ts` (service role, signature-verified); outbound BSP client `src/lib/whatsapp.ts`; a queue worker mapping `notifications` rows with `channel='whatsapp'` to the BSP; phone→user resolver.

**T6 — Contractor/mechanic job media: quotes, invoices, photos** *(FR-8.2, FR-4.5 photos; §20 invoice→cost)*
- **Acceptance:** (a) On a job card, a contractor/mechanic can upload quote/invoice/photo attachments (farm-scoped storage). (b) An invoice's amount can be recorded as a cost line/`CostEntry` that flows to the asset total (ties to T3). (c) Media is visible to owner/manager on the card.
- **Touch:** `jobcards/[id]/page.tsx` + `jobcards/actions.ts` (reuse `uploadFaultMedia` pattern / `attachments` + `jobcard-photos` bucket); add invoice-amount → cost line.

**T7 — Plans, per-vehicle billing & entitlement gating** *(FR-19.1, FR-19.2)*
- **Acceptance:** (a) Four plans Essential/Professional/Complete/Done-For-You with per-vehicle-per-month pricing and unlimited users. (b) Feature entitlements enforced server-side: e.g. dashboard = Professional+, voice AI & AARTO = Complete+ — an under-plan farm is denied at the route/action, not just hidden. (c) Billing state per farm (asset count, period).
- **Touch:** replace `farm_tier` enum + add `subscriptions`/entitlements (migration); an `app.has_entitlement(farm, feature)` helper + guards in the relevant routes/actions; admin billing UI; payment provider integration (scope separately).

**T8 — Service kits & parts catalogue** *(FR-5.1 P0; FR-5.2–5.3 P1)*
- **Acceptance:** (a) Each machine (or type) carries a pre-loaded service kit: engine-oil / gearbox-oil / filter **part numbers**. (b) A parts catalogue (part no, description, supplier, typical cost) exists. (c) Selecting kit parts on a service auto-appends them to cost + history.
- **Touch:** new `service_kits`, `parts_catalogue` tables + migration + RLS; machine-detail kit UI; job-line "add from catalogue"; seed a starter catalogue.

**T9 — AARTO driver-usage log** *(FR-13.1 P0; enables FR-13.2, §23 AARTO)*
- **Acceptance:** (a) A `UsageLog` records which driver operated which vehicle and when. (b) Usage is captured at job/reading/QR time (driver selectable). (c) The log is queryable to identify the driver on a given date (AARTO nomination basis).
- **Touch:** new `usage_logs` table + migration + RLS; capture hooks in reading/job/QR flows; a usage view on asset detail.

**T10 — Fault → Out-of-service + location capture** *(FR-7.5 P1, FR-7.2 location P0-part)*
- **Acceptance:** (a) Reporting a fault (esp. `stopped`) can set the asset status to Out of service, with a manager override. (b) Fault capture records geolocation when the browser grants it.
- **Touch:** `api/faults/route.ts` + `api/public/fault/route.ts` (optional status flip); `fault-capture.tsx` (geolocation); `faults` schema (add `lat/lng` or reuse a location text).

**T11 — QR quick actions: log service + log fuel** *(FR-9.2 P0)*
- **Acceptance:** Scanning a QR offers **log service, log fuel, report fault** (currently only fault + reading).
- **Touch:** `m/[token]/page.tsx` + `m/[token]/actions.ts` (add service + fuel actions via service role, token-gated).

**T12 — Multi-site under one account** *(FR-1.5 P0)*
- **Acceptance:** One owner account can own multiple farms/sites with per-site isolation preserved; dashboards/reports filter per-site (ties to FR-11.3).
- **Touch:** new `organisations` layer or a user↔farm membership table (migration + RLS rewrite of `accessible_farm_ids`); site switcher in the app shell.

**T13 — Push notifications + licence-expiry reminders** *(FR-14.1 push + licence P0-part)*
- **Acceptance:** Web-push subscription + delivery for service-due/overdue and licence/warranty expiry; licence-expiry engine mirrors the service engine.
- **Touch:** VAPID + `push_subscriptions` table; SW push handler (ties to T1); extend `0205`-style engine with warranty/licence expiry (needs T14 licences).

**T14 — POPIA + security/backup documentation & flows** *(NFR-3 P0; NFR-2, NFR-4 hardening)*
- **Acceptance:** (a) Documented retention & deletion policy; a data-subject deletion/export flow for personal/driver data. (b) Documented encryption-in-transit/at-rest + credential hashing (verify Supabase config). (c) Documented backup + restore runbook + uptime target.
- **Touch:** `docs/POPIA.md`, `docs/SECURITY.md`, `docs/BACKUP.md`; a deletion RPC + admin flow; verify Supabase project settings.

### P1 / P2 tickets (summary — full detail deferred)
- **FR-2.3** per-role visibility (operator→assigned assets, contractor→assigned jobs): add RLS predicates using `assigned_operator_id` + a job-assignment table.
- **FR-3.6** assign default operator UI (field already exists).
- **FR-3.2/3.4** finance details + location/cost-centre/department grouping & filters.
- **FR-4.7** warranty display + expiry reminders (fields exist).
- **FR-7.3** fault lifecycle (Acknowledged/In-progress) + assignee.
- **FR-11.2** true per-machine repeat-repair metric; **FR-11.3** per-site/group filters; **FR-11.4** Excel export.
- **FR-14.3** per-user notification preferences.
- **FR-18.1** self-service per-user language switcher; localise the admin console.
- **NFR-5/6/7** accessibility audit, observability/error logging, and server-side pagination for scale.
- P2: FR-2.5 custom roles, FR-5.4 inventory, FR-6.4 fuel-card, FR-9.4 QR re-issue, FR-10.5 repair-vs-replace, FR-11.5 scheduled reports, FR-17.2/17.3 accounting/API, FR-19.4 self-hosted.

---

## 3. Divergences & contradictions (things that look done but aren't, or deviate from spec)

- **D-1 — "PWA" ≠ offline.** `manifest.webmanifest` + install metadata make it *installable*, which can read as "offline-ready." There is **no service worker and no local store**, so every FR-1.3/FR-15 acceptance criterion fails. This is the single most important "looks done, isn't" item.
- **D-2 — Cost-per-hour math is inconsistent.** In `reports/data.ts`, `perHour = round(total_in_selected_period / machine.current_reading)` — a **period-scoped numerator over a lifetime-hours denominator**. Change the period and the "cost per hour" changes even though lifetime hours didn't. It also isn't TCO-based. Machine detail uses lifetime-spend/lifetime-hours (defensible) but the two surfaces disagree.
- **D-3 — TCO is really "maintenance spend."** Both the asset detail "Total spend" and reports label job-card sums as the asset's cost. Purchase price, finance, and fuel are excluded, so any "true cost of ownership" reading is materially understated. (FR-10.2 / §23.)
- **D-4 — `tier` implies plan gating that doesn't exist.** Farms carry a tier and the admin UI edits it, but **no feature anywhere checks it**. A reader would reasonably assume entitlements are enforced (FR-19.2); they are not.
- **D-5 — Dead settings.** `approval_required` and `cost_visible_to_operators` are persisted and shown in Settings but **never enforced** in any route/action (`grep` shows reads only in the settings form). Job cards can be approved regardless of `approval_required`; operators are not actually blocked from costs.
- **D-6 — Fault lifecycle diverges from spec.** Enum `open/in_job/scheduled/resolved` (workflow-oriented) instead of `Open→Acknowledged→In-progress→Resolved`, and there is no assignee. Reports/dashboards that say "open vs resolved" therefore can't express Acknowledged/In-progress.
- **D-7 — "Voice-note" vs "Voice control."** The presence of a voice **recording** on faults can be mistaken for the FR-12 voice **assistant**. They are unrelated; no speech recognition exists.
- **D-8 — Completion doesn't enforce the mandatory meter reading.** `completeJobCard` comments say the meter reading is mandatory at service (Scope §4.4) but the code makes it optional (`...(meterReading != null ? {...} : {})`). Minor, but the service-line "last done reading" can be left stale.
- **D-9 — `assigned_operator_id` / warranty fields are inert.** Columns exist and (for warranty) are editable, but nothing surfaces or acts on them — easy to mistake as satisfying FR-3.6 / FR-4.7.
- **D-10 — Naming mismatch.** The product is "FarmGear" throughout; the spec is "FleetWise." Not a defect, but confirm this is a rename and not two separate products before treating this repo as the FleetWise codebase.

---

## 4. Production-readiness gate (§24) — **NO-GO**

The §24 gate requires **all** of the following. Current state:

| Gate condition | Verdict |
|---|---|
| All P0 requirements implemented, tested, passing acceptance criteria | ❌ ~15 of 40 P0s missing, ~14 partial (incl. offline, fuel, voice, WhatsApp, TCO, service kits, AARTO, billing/entitlements). |
| Every §20 data flow works end to end across app, QR, voice, WhatsApp | ❌ Only the app/QR service-and-fault flow works. Voice and WhatsApp inputs don't exist; fault→out-of-service, contractor-invoice→TCO, and fuel→due don't exist. |
| Offline capture + sync verified with conflict cases, no data loss | ❌ No offline layer at all. |
| All §23 metrics compute correctly on real-shaped data | ❌ TCO, cost/km, fuel, budget, utilisation, warranty/licence, AARTO all missing; cost/hour math inconsistent (D-2). |
| NFR security, POPIA, backup/restore, performance verified | 🟡/❌ Tenant isolation is strong and tested; POPIA, backup/restore, and perf targets are undocumented/unverified. |
| Plan entitlements enforced; billing correct; EN/AF complete, no missing strings | ❌ No entitlements, no billing. ✅ EN/AF is genuinely complete (429/429). |

**Call: NO-GO for FleetWise production.** What *is* production-grade is the tenancy/RLS core, the service-due engine, job-card money handling, and the EN/AF localisation — a solid foundation to build the missing platform on. The launch-critical fleet capabilities (offline, fuel, voice, WhatsApp, TCO, service kits, AARTO, billing/entitlements) are the work that stands between here and the gate; **T1–T14** above are the path.

---

*Prepared as a read-only audit. No application code was modified. Recommend socialising the P0 ticket list (T1–T14) and confirming the FarmGear→FleetWise scope reconciliation (D-10) before sequencing the build.*
