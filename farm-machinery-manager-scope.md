# Farm Machinery & Vehicle Manager — Full Project Scope
**Working name:** TBD (referred to below as "the platform") · **Owner:** Rapid Rise AI · **Version:** 1.0 · **Date:** July 2026

---

## 1. Vision & Positioning

A simple, cloud-based machinery and vehicle management platform for South African farms, sold as the first module of a growing farm operations system. It gives farmers a complete, always-current picture of every machine they own: what it costs, when it needs service, what's broken, who fixed it, and where the money is going.

**The core insight that shapes the whole design:** systems like this die when nobody enters data. So the platform is built around an asymmetry — **mechanics and workshops enter most of the data** (job cards, services, parts, costs) as a natural part of doing their job, **workers capture small events in seconds** (faults, hours, fuel) by scanning a QR code, and **farmers mostly consume** (dashboards, WhatsApp alerts, reports). The farmer should get value even if he personally never types anything.

**Differentiators vs. existing tools (MaintainX, Fleetio, Farm Service Manager, Farmworks, etc.):**
1. Local, personal onboarding — we drive out, set it up, load the machines, and train the team at the kitchen table. Big SaaS tools make the farmer do this alone.
2. Mechanic-first data entry via a trusted local workshop network — the data actually gets captured.
3. WhatsApp-native alerts — no new app for the farmer to remember to open.
4. SA-specific value: SARS diesel rebate logbook support (module 2), Afrikaans/English interface, Rand pricing, POPIA-aware.
5. Founding Farmer pricing: locked-in low rate, free setup and training, direct line to the builders, early access to every future module.

**Business goal:** 20 paying farms at an average of R1,500/month within 4 months (R30,000/month recurring). Development time is the scarcest resource — v1 must be buildable in ~3 weeks so the remaining time goes to selling and onboarding.

---

## 2. Users & Roles

| Role | Who they are | What they do in the system | Access level |
|---|---|---|---|
| **Owner (Farmer)** | Farm owner / boss | Views dashboard, cost reports, approves big jobs, receives WhatsApp alerts | Full read, approval actions, settings |
| **Farm Manager** | Foreman / manager | Everything the owner sees + creates fault reports, assigns jobs, updates machine hours, manages workers | Full read/write except billing & farm settings |
| **Mechanic (internal)** | Farm's own workshop worker | Opens & completes job cards, logs services, parts, costs, photos | Job cards, services, machine history |
| **Workshop (external)** | Outside mechanic business (e.g. TJ Service & Repairs) serving multiple farms | Same as internal mechanic, but scoped per client farm; sees only machines of farms that granted access | Job cards & history for linked farms only |
| **Operator / Worker** | Tractor driver, general worker | Scans QR on a machine → reports a fault (photo + voice note/text), logs hour-meter reading, logs fuel fill | Minimal: submit-only forms, own submissions |
| **Rapid Rise Admin** | Xander / staff | Creates farms (tenants), manages subscriptions, seeds templates, support access | Super admin across tenants |

Design rule: **every role's daily action must take under 60 seconds on a phone.** A worker reporting a fault = scan, snap, describe, send. A mechanic closing a job card = fill 8–12 fields, mostly dropdowns and numbers.

---

## 3. Module Map (the growth story)

| Phase | Module | Status |
|---|---|---|
| **v1 (build now)** | Machine & Vehicle Asset Manager: registry, QR codes, service scheduling, job cards, fault reporting, cost tracking, dashboard, WhatsApp alerts, reports | This document, sections 4–8 |
| **v1.5 (weeks 5–8)** | Diesel & Fuel module: tank storage log, per-machine usage log, SARS diesel-rebate-format logbook export, consumption per machine | Section 9 |
| **v2 (roadmap — sell the vision, don't build yet)** | Spray/chemical records (GlobalGAP/SIZA audit support), implements & workshop stock, worker task management, livestock/crop modules, telemetry & anomaly detection | Roadmap slide only |

The roadmap is a **sales asset**: founding farmers are buying into the trajectory, not just v1. But nothing in v2 gets built until revenue targets are met.

---
## 4. v1 Functional Scope — Detailed

### 4.1 Machine & Vehicle Registry (the foundation)
Every asset on the farm gets a profile. Asset types: tractor, harvester/combine, bakkie/LDV, truck, implement (plough, planter, sprayer, baler…), pump/generator/stationary engine, ATV/other.

**Fields per machine:**
- Name / nickname (what the farm actually calls it, e.g. "Groen John Deere")
- Type, make, model, year
- Serial number / VIN, registration number (if road-legal)
- Meter type: **hours** or **kilometres** (or none, for calendar-only assets like pumps)
- Current meter reading + date of reading (history of readings kept)
- Purchase date, purchase price, supplier (optional)
- Warranty expiry (date and/or hours)
- Status: **Active / In workshop / Standby / Retired / Sold**
- Photo(s), documents (manual PDF, licence disc, insurance)
- Assigned operator (optional), location/camp (free text v1)
- Notes

**Behaviours:**
- Retired/Sold machines keep full history but drop out of alerts and dashboards.
- Machine list filterable by type/status; searchable.
- Bulk import via spreadsheet (used during onboarding, admin-only).

### 4.2 QR Codes — the physical bridge
- Every machine gets a unique QR code, generated by the system, printed as a weatherproof sticker (lamination/vinyl — part of the install kit).
- Scanning with any phone camera opens the machine's public-lite page (no login): machine name + two big buttons: **"Report a problem"** and **"Log reading / fuel"**, plus a login link for full history.
- Logged-in users scanning the code land straight on the full machine profile.
- QR pages must load fast on poor rural signal (target < 100 KB initial load).

### 4.3 Service Scheduling (preventive maintenance)
Farm machinery servicing is driven by **engine hours first, calendar second** — e.g. engine oil ±every 250 hours, hydraulic/transmission service ±every 500 hours, coolant ±annually/1,000 hours, with intervals shortened in dusty conditions. The system must handle **both triggers, whichever comes first**.

**Service Plan model:**
- Each machine gets one or more service plan lines: *task* (e.g. "Engine oil + filter"), *interval in hours/km* and/or *interval in months*, *last done at* (reading + date), *next due at* (auto-calculated).
- **Templates library** (seeded by Rapid Rise, editable per farm): "Tractor — standard", "Bakkie/LDV", "Harvester", "Pump/Generator", "Implement — greasing schedule". Templates pre-load typical lines (50h/250h/500h/1,000h services, annual checks) so setup per machine takes seconds, then gets tuned to the manufacturer's manual per machine.
- Due-soon logic: warning threshold configurable per farm (default: 25 hours or 14 days before due; overdue = past due point).
- Statuses: OK → Due soon → Overdue. Colour-coded everywhere (green/amber/red).

**Meter updates feed the schedule.** Hour/odo readings come from: worker QR submissions, mechanic job cards, manager entry, or the weekly WhatsApp nudge (see 4.7). Stale readings (no update in X days, default 30) flag the machine as "reading outdated" so due-dates aren't silently wrong.

### 4.4 Job Cards (the mechanic's workflow — the heart of data entry)
A job card records everything about one repair/service event, modelled on real workshop job cards but stripped to essentials.

**Job card lifecycle:** `Reported → Open → In progress → Waiting for parts → Completed → (optional) Approved`

**Fields the MECHANIC fills in:**
1. Machine (pick from list or arrive via QR scan / fault report)
2. Date in, date out
3. **Meter reading at service** (hours or km — mandatory; this also updates the machine's meter)
4. Job type: *Scheduled service* (link to the service-plan line(s) being done) / *Repair* / *Inspection* / *Other*
5. Reported problem / reason (pre-filled from fault report if one exists)
6. Diagnosis / cause (short text; dropdown of common causes + free text)
7. Work performed (checklist from service template if scheduled service; free text lines for repairs)
8. **Parts used**: description, part number (optional), quantity, unit cost → line totals
9. **Labour**: hours × rate (rate defaults per mechanic/workshop, editable) — external workshops can instead enter a single labour/invoice amount
10. Other costs (transport/call-out, consumables, outside services)
11. Photos: before / after / old part / supplier invoice (phone camera, auto-compressed)
12. Recommendations / next attention items (e.g. "front tyres 50% — replace before planting season") → these become open "watch items" on the machine
13. Done by (auto from login) + optional co-workers
14. Sign-off: mechanic marks Completed; owner/manager gets notified and can Approve (approval optional per farm setting)

**Behaviours:**
- Total cost auto-calculated (parts + labour + other). Farm can choose whether workers/operators can see costs (default: hidden from operators).
- Completing a job card that covers service-plan lines resets those lines' "last done" automatically — no double entry.
- A job card can be created *from* a fault report in one tap (fault → job).
- Draft job cards save automatically (poor-signal tolerance).
- Job card prints/exports to a clean PDF (workshop can hand it to the farmer / attach to invoice).

### 4.5 Fault Reporting (the worker's 30-second flow)
- Entry points: QR scan (primary), app menu, or manager on behalf of a worker.
- Form: machine (pre-filled from QR), what's wrong (short text; big common-fault buttons: won't start / leak / noise / tyre / hydraulic / electrical / other), photo(s), optional voice note, urgency (Can work / Limping / Stopped).
- On submit: owner + manager (and linked mechanic, per farm setting) get a WhatsApp/notification. Fault appears on dashboard as open issue with age counter.
- Faults tracked: `Open → In job / Scheduled → Resolved`. Every fault keeps its trail (who reported, when, photos, which job card resolved it).

### 4.6 Dashboard & Machine History
**Farm dashboard (owner/manager landing page):**
- Traffic-light service board: overdue / due soon / OK counts + list
- Open faults (with urgency + age)
- Machines currently in workshop (with days-in count)
- This month's spend vs last month
- Stale meter readings needing update

**Machine profile page:** identity card, current status, meter history graph, service plan with due bars, full timeline (every job card, fault, reading, cost — newest first), watch items, documents, lifetime stats (total cost, cost per hour, cost per year, top recurring parts).

### 4.7 WhatsApp Alerts & Nudges (the farmer's interface)
WhatsApp is the primary outbound channel; email is secondary/optional. v1 launches with a **practical two-stage approach**:
- **Stage 1 (first clients, week 1):** WhatsApp Business App used manually/semi-manually by Rapid Rise for the handful of pilot farms (zero API cost, zero approval delay), while the in-app notification centre carries everything.
- **Stage 2 (as farms scale):** WhatsApp Business Platform (API) via a BSP (e.g. 360dialog / Twilio / WATI — choose cheapest reliable ZA option at build time), using **utility templates**. Pricing is per delivered template message and utility messages are the cheap category, so cost per farm stays trivially low (a farm receiving ~40 alerts/month costs only a few rand). Replies within the 24-hour service window are free — so the weekly nudge can collect hour readings by reply at no message cost.

**Message set (all utility-category, all bilingual):**
1. Service due soon: "🚜 {Machine}: {task} due in {X} hours / on {date}."
2. Service overdue (escalation, weekly until done)
3. New fault reported: "{Machine}: {problem} — reported by {name}. Urgency: {level}."
4. Job status: opened / waiting for parts / completed (with cost summary to owner)
5. Weekly digest (Mon 06:00): due list + open faults + machines in workshop
6. Weekly meter nudge (optional, per farm): "Reply with hour readings: 1. Groen JD ___ 2. Rooi Massey ___"
- Every alert links straight to the relevant page. Quiet hours respected (no non-urgent messages 20:00–05:00). Opt-in per recipient (POPIA).

### 4.8 Reports (v1 set — simple, printable, exportable)
1. **Cost per machine** (period-filterable): parts / labour / other split, total, cost-per-hour
2. **Farm maintenance summary** (monthly/quarterly/yearly): spend by machine, by job type, by workshop
3. **Service compliance**: services done on time vs late; current overdue list
4. **Recurring problems**: most-replaced parts and most-frequent fault categories per machine (this is the "what keeps breaking" report — simple counts in v1, no ML)
5. **Machine file export**: full history PDF per machine — the "service book" that boosts resale value and warranty claims
- All reports: on-screen, PDF download, CSV export. VAT-aware cost display (enter costs incl/excl VAT — farm setting; store ex-VAT + rate).

### 4.9 Administration, Tenancy & Settings
- **Multi-tenant:** one codebase/database; every farm is a tenant; strict row-level isolation. External workshops are their own accounts linked to ≥1 farm tenants.
- Farm settings: name, currency (ZAR), VAT handling, language default (EN/AF per user), alert thresholds, approval toggle, cost-visibility toggle, quiet hours.
- User management: invite by phone number (WhatsApp deep link) or email; assign role; deactivate.
- Rapid Rise admin console: create farm, set subscription tier & status (trial/active/suspended), impersonate-for-support (logged), seed template library, usage stats per farm (for churn radar: last activity, jobs logged this month).
- Audit log: who changed what, when (critical for trust: costs and history must be tamper-evident; job cards lock after approval, edits create versions).

---

## 5. What Each Person Actually Does (day-in-the-life flows)

**Worker (Thabo, tractor operator):** Tractor starts smoking. He scans the QR on the mudguard, taps "Report a problem", taps "Noise/Smoke", takes a photo, taps "Limping", sends. Done in 40 seconds. Monday morning he scans again and types the hour reading when the WhatsApp nudge asks.

**Mechanic (internal or Pa's workshop):** Gets WhatsApp: "Groen JD: smoking under load — Limping." Opens the fault → "Create job card". Fills meter reading, diagnosis "blocked air filter + injector service", ticks the 500h service lines while he's in there, adds parts (2× filters, 18ℓ oil) with costs, 3.5h labour, snaps the old filter and the invoice, marks Completed. The 500h service line resets itself; the owner gets the cost summary automatically.

**Owner (Oom Danie):** Never opens a laptop. Gets the Monday 06:00 digest on WhatsApp, gets fault alerts, gets "job completed — R4,860" summaries. Once a month he opens the cost report on his phone before the co-op meeting. At year-end he pulls each machine's PDF file for his accountant and insurance.

**Rapid Rise (Xander):** Creates the farm in admin, imports the machine list captured during the site visit, prints QR stickers, drives out, sticks them on, trains for an hour, leaves. Watches the usage stats; if a farm goes quiet for 2 weeks, that's a churn-risk phone call.

---

## 6. Data Model (entities & key fields)

```
farms (tenants)        id, name, tier, status, settings(jsonb), created_at
users                  id, farm_id (null for external workshop staff & RR admins),
                       role, name, phone, email, language, whatsapp_opt_in, active
workshops              id, name, contact — external mechanic businesses
workshop_links         workshop_id ↔ farm_id (+ status)  — grants scoped access
machines               id, farm_id, name, type, make, model, year, serial_no, reg_no,
                       meter_type(hours|km|none), status, purchase_date, purchase_price,
                       warranty_expiry_date, warranty_expiry_hours, photo_urls, docs, notes
meter_readings         id, machine_id, reading, reading_date, source(qr|job|manual|whatsapp), by_user
service_templates      id, farm_id(null=global), machine_type, name, lines(jsonb)
service_plan_lines     id, machine_id, task, interval_hours, interval_months,
                       last_done_reading, last_done_date, next_due_reading, next_due_date, status
faults                 id, machine_id, reported_by, description, category, urgency,
                       photos, voice_note_url, status, job_card_id, created_at, resolved_at
job_cards              id, machine_id, farm_id, created_from_fault_id, type, status,
                       date_in, date_out, meter_reading, reported_problem, diagnosis,
                       work_performed, recommendations, mechanic_user_id, workshop_id,
                       approved_by, approved_at, locked, totals(computed)
job_card_lines         id, job_card_id, kind(part|labour|other), description, part_no,
                       qty, unit_cost, hours, rate, total
watch_items            id, machine_id, source_job_card_id, text, status(open|done|dismissed)
attachments            id, parent_type, parent_id, url, kind(photo|invoice|doc), created_by
notifications          id, farm_id, user_id, channel(whatsapp|inapp|email), template,
                       payload, status(queued|sent|delivered|failed), created_at
fuel_tanks (v1.5)      id, farm_id, name, capacity_l
fuel_deliveries (v1.5) id, tank_id, date, supplier, invoice_no, litres, price_per_l, doc_url
fuel_issues (v1.5)     id, tank_id, machine_id, date, litres, meter_reading, activity, by_user
audit_log              id, farm_id, user_id, entity, entity_id, action, diff(jsonb), at
```
Money stored in cents (integer), ex-VAT, with VAT rate captured. All history immutable-by-default (soft delete + audit).

---

## 7. Non-Functional Requirements

- **Mobile-first PWA.** 95% of usage is on phones, often mid-range Androids. Installable to home screen; no app-store builds in v1.
- **Low-bandwidth tolerant.** Pages < 200 KB where possible; photos compressed client-side (~200–400 KB); submissions retry automatically on flaky signal; drafts never lost. *Full offline mode is explicitly out of scope for v1* — but the QR fault form and job-card draft must survive a dropped connection.
- **Bilingual:** English + Afrikaans UI toggle per user. All WhatsApp templates in both. (Language file structure ready for isiZulu/Sepedi later.)
- **POPIA:** minimal personal data (name, phone, role); consent checkbox for WhatsApp; per-farm data isolation; export & delete on request; SA/EU data residency where the host allows.
- **Retention:** all records kept ≥ 5 years (aligns with SARS record-keeping expectations for the diesel module) and never auto-purged while a farm is active.
- **Security:** row-level security per tenant, role-based permissions, signed URLs for photos/docs, admin impersonation logged.
- **Performance target:** dashboard < 2s on 3G-ish rural LTE; QR page < 1s.
- **Reliability:** daily automated DB backups, point-in-time recovery, uptime target 99.5% (farms are daytime users; maintenance windows at night).

---

## 8. Tech Stack & Architecture (recommended)

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js (React) PWA**, Tailwind | Fast to build with Claude Code, one codebase for all roles, PWA install |
| Backend/DB | **Supabase** (Postgres + Auth + Storage + RLS) | Already in the Rapid Rise toolset; RLS gives clean multi-tenancy; storage for photos; realtime for dashboard |
| Hosting | Vercel (app) + Supabase cloud | Zero-ops, cheap at this scale |
| WhatsApp | Stage 1: WhatsApp Business App (manual). Stage 2: BSP (360dialog / WATI / Twilio) utility templates via a small queue worker | Cost ~ nothing at pilot scale; per-message utility pricing stays cheap at 20 farms |
| PDFs | Server-side HTML→PDF (e.g. Playwright/pdf lib) | Job cards, machine files, reports |
| QR | Generated server-side (SVG/PNG), printed on vinyl sticker sheets | Install kit |
| Analytics/ops | Simple internal usage stats + error tracking (e.g. Sentry) | Churn radar |

**Architecture notes for the build:**
- One Postgres schema, `farm_id` on every row, RLS policies per role; external workshop access via `workshop_links` join policies.
- Notification service = table-driven queue (`notifications`) + cron worker; channel adapters (in-app now, WhatsApp API later) so Stage 1→2 is a config change, not a rewrite.
- Due-date recalculation runs on every meter reading + nightly cron (catches calendar-based dues).
- Seed script creates a **demo farm** with realistic data (12 machines, histories, faults) — this is the sales demo and the training sandbox.

---

## 9. Module 2 (v1.5): Diesel & Fuel — the module that pays for itself

South African farmers can claim back part of the fuel levies on diesel used off-road in farming (the SARS diesel refund), but claims stand or fall on **logbooks**: SARS expects a full diesel trail — purchases/storage into tanks and usage per machine/activity — with records kept for years and claims audited; incomplete logbooks are a top reason claims fail. Industry surveys have found most farmers find the logbook burden genuinely hard. That makes this module a **rand-positive purchase**: the rebate is worth roughly R1+ per eligible litre, so even a modest farm recovers multiples of the subscription — *if* the records are right.

**Scope:**
- Tank register (storage), delivery log (date, supplier, invoice no., litres, price, invoice photo)
- Fuel issue log per machine: date, litres, meter reading, activity (dropdown of qualifying activities), issued by — capturable via the same QR flow ("Log fuel")
- Tank reconciliation view (deliveries − issues vs dip reading)
- **SARS-format usage & storage logbook exports** (modelled on the published SARS logbook layout) + litres-per-hour consumption per machine (feeds the "something's wrong / possible theft" conversation)
- Explicit disclaimer in-product: we produce the records; the farmer/accountant makes the claim.

Build estimate: ~1 week, reusing machines, QR, meter readings, attachments, reports.

---

## 10. Build Plan (Claude Code execution phases)

**Week 1 — Foundation.** Repo + Supabase project; schema + RLS; auth & roles; farm/tenant admin console; machine registry CRUD + photos/docs; meter readings; QR generation + public-lite QR page; seed/demo farm script.
**Week 2 — The core loops.** Service templates + plan lines + due engine; fault reporting flow (QR entry, photos, urgency); job cards end-to-end (lifecycle, lines, costs, photo capture, service-line reset, PDF); watch items.
**Week 3 — The farmer layer.** Dashboard; machine history timeline; reports 1–5 + CSV/PDF; notification queue + in-app centre + Stage-1 WhatsApp playbook; Afrikaans translation pass; settings; polish, empty-states, onboarding checklist.
**Week 4 — Pilot.** Install at pilot farm #1 (via Pa's workshop) + external-workshop account for the workshop itself; fix the friction found in real use; print/install QR kits; sales collateral (demo farm walkthrough, one-pager, Founding Farmer offer sheet).
**Weeks 5–8 — Sell + v1.5.** Sales visits at 2–3/week off warm intros; diesel module built in parallel; iterate from founding-farmer feedback.

**Definition of done for v1:** a real farm can run the full loop — worker reports fault → mechanic completes job card → owner gets WhatsApp summary → service plan updates → month-end cost report prints — with no help from us.

---

## 11. Onboarding Playbook (per new farm — repeatable, ~half a day)

1. **Pre-visit:** create tenant; capture machine list by phone/WhatsApp (or from insurance schedule — every farm has one); bulk-import; print QR stickers.
2. **Site visit:** stick QRs (wipe surface, laminate over), photograph each machine, confirm meter readings, load each machine's service intervals from its manual/dealer sheet (templates make this fast).
3. **Training (60–90 min):** workers — the QR scan flow (do it live on 3 machines); mechanic — one real job card together; owner — WhatsApp alerts + dashboard on his phone.
4. **Handover pack:** laminated cheat-sheet (AF/EN) per role; support WhatsApp number.
5. **Follow-up:** day-3 check-in call; week-2 usage review; month-1 "first cost report" walkthrough — this meeting is also the testimonial/referral ask.

---

## 12. Pricing & Packaging (Founding Farmer)

| Tier | Fleet size | Standard | Founding Farmer (first 20 farms, locked for life) |
|---|---|---|---|
| Starter | up to 10 machines | R1,400/m | **R1,000/m** |
| Standard | up to 25 machines | R2,200/m | **R1,600/m** |
| Large | unlimited | R3,200/m | **R2,400/m** |

All tiers: unlimited users, free setup visit + QR kit + training (Founding Farmers), WhatsApp alerts included, diesel module included when released. Month-to-month, cancel anytime (confidence signal). First month free after install. External workshops: free accounts (they are the data engine and a referral channel — every workshop serves many farms).

**Unit economics sanity check:** hosting + WhatsApp + tools ≈ R50–R150/farm/month at this scale → 90%+ gross margin; 20 farms ≈ R30k/m on the founding mix.

---

## 13. Out of Scope for v1 (say no, protect the timeline)

GPS/telemetry hardware and live tracking; automated anomaly detection (v1 ships simple recurring-cost counts instead); full parts-inventory/stock module (parts live on job cards only); invoicing/accounting (export CSV for the accountant instead); crop/livestock/labour modules; iOS/Android store apps; full offline sync; integrations (co-op systems, Sage, John Deere Ops Center); more than 2 languages.

---

## 14. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Data entry fades after novelty | Mechanic-first design; weekly WhatsApp nudges; usage-based churn radar + phone call; month-1 report meeting proves value |
| Poor farm connectivity | Low-data pages, retry queues, draft autosave; QR page ultra-light |
| Farmers see it as "nice to have" | Lead sales with money: missed-service horror stories, resale value of a full service file, diesel rebate maths |
| WhatsApp API approval/template delays | Stage-1 manual WhatsApp from day one; API is an upgrade, not a dependency |
| One-man development bottleneck | Ruthless v1 scope; templates over custom work; Claude Code for velocity; weekly cut-line review |
| Price resistance | Founding tier + first month free + cancel anytime; anchor against one service invoice |
| Key-person sales dependency (Pa's network) | Turn every workshop into a channel (free workshop accounts); testimonial from farm #1 by week 6 |

---

## 15. Success Metrics (first 4 months)

- **Commercial:** 20 paying farms; MRR ≥ R30,000; churn ≤ 1 farm.
- **Adoption per farm:** ≥ 80% of machines with QR + service plan loaded; ≥ 4 job cards/month by month 2; meter readings ≤ 30 days old on ≥ 80% of active machines; owner opens ≥ 2 reports/month.
- **Pipeline:** ≥ 3 demos/week from week 5; ≥ 1 referral per founding farm.

## 16. Open Items

1. **Name & brand** the product (bilingual-friendly, farm-credible).
2. Confirm BSP choice + register WhatsApp Business Platform when moving to Stage 2.
3. Collect 3–5 real service-interval sheets (John Deere, Massey, New Holland, common bakkies) from Pa/dealers to seed the template library with credible defaults.
4. Founding Farmer one-pager + demo script (sales collateral, week 4).
5. Legal touches: simple subscription terms, POPIA privacy notice, diesel-module disclaimer.
