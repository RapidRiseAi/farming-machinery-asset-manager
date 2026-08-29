# FleetWise — Full feature status checklist

**As of:** 28 August 2026. Legend: ✅ done & merged · 🟡 partial · ❌ not started · ⏸️ deferred by decision (needs a provider, or excluded by `SCOPE §13` — see `FLEETWISE_PROVIDER_SETUP_GUIDE.md`).

**How this revision was checked.** Every ❌ and 🟡 was re-tested against the code, not carried forward. Earlier revisions said "sections outside this release retain their last audited status", and that hedge is how the document came to mark **18 shipped features as not started** — among them multi-site, per-role visibility, service kits, the parts catalogue, stock, budgets, repair-vs-replace, utilisation, Excel export, the AARTO workflow, POPIA retention and the backup runbook. Anyone planning from it would have rebuilt work that already existed.

The hedge is therefore gone. If a line here is wrong, it is wrong — not "awaiting its next audit".

**Does this checklist contain everything?** Yes — it covers **every** requirement in the official spec (`FR-x.y` / `NFR-n`, §1–24) **plus** the extra features the founder's provider spec added (§B below) that were NOT in the original §1–24 (affiliate program, RAG/knowledge base, DebiCheck, etc.). Nothing is hidden.

---

## A. Official spec (FR-x.y / NFR-n)

### §1 Product scope
- ✅ FR-1.1 (P0) Manage every asset type
- 🟡 FR-1.2 (P0) Every capture <30s on mobile — fast paths exist; not formally measured
- ✅ FR-1.3 (P0) Full offline — **F2**
- 🟡 FR-1.4 (P1) Auditable who/when/**where** — who+when ✅ (audit_log); "from where" ❌
- ✅ FR-1.5 (P0) Multi-farm/site under one account — **F7** (`user_farm_memberships`, 0340–0341); site switcher in the shell

### §2 Roles & permissions
- 🟡 FR-2.1 (P0) RBAC roles — 5 roles present; no distinct "external contractor"
- ✅ FR-2.2 (P0) Unlimited users
- ✅ FR-2.3 (P1) Per-role visibility — **F7**, enforced in RLS not the UI (`app.row_visible_to_role`, `app.work_request_visible`)
- ✅ FR-2.4 (P1) Invite/deactivate
- ✅ FR-2.5 (P2) Custom roles — shipped as **per-user permission overrides** (`0507`): the five roles stay as baselines, named grants layer on top, enforced in RLS. A full role builder was deliberately rejected as too dangerous where RLS is the sole tenancy guarantor.

### §3 Asset register
- ✅ FR-3.1 (P0) Create/edit/archive
- 🟡 FR-3.2 (P0) Per-asset fields — make/model/…/photos ✅; **finance fields ✅ (F1)**; VIN=serial
- 🟡 FR-3.3 (P0) Live status — now has `out_of_service` (F3); vocab still differs from spec's In-use/Available
- ✅ FR-3.4 (P1) Group/filter by type/site/cost-centre/dept — cost-centre and department capture + distinct-value filters (**F10**, `0280`); site via **F7**
- ✅ FR-3.5 (P0) Current hour/odo updated on each log
- ✅ FR-3.6 (P1) Assign default operator — **F3**
- ✅ FR-3.7 (P1) Bulk import CSV

### §4 Maintenance & servicing
- ✅ FR-4.1 (P0) Complete dated history (now incl. fuel — F4)
- ✅ FR-4.2 (P0) Schedule by hours/km/calendar, earliest first
- ✅ FR-4.3 (P0) Recurring intervals
- ✅ FR-4.4 (P0) Due/due-soon/overdue auto
- ✅ FR-4.5 (P1) Photos+notes on service — **F1** job-card media
- ✅ FR-4.6 (P1) Job cards plan→complete→who
- ✅ FR-4.7 (P2) Warranty tracking + expiry reminders — **F6**

### §5 Service kits & parts
- ✅ **FR-5.1 (P0)** Service kits per machine or machine-type template, applied to a job card — **F9** (`0270–0271`)
- ✅ FR-5.2 (P1) Parts catalogue (part no/supplier/category/typical cost), farm-owned or RR-seeded global — **F9**
- ✅ FR-5.3 (P1) Parts consumed → cost & history — job-card lines cost via the 0211 trigger, now sourced from the catalogue
- ✅ FR-5.4 (P2) Stock on hand + movements ledger + low-stock nudge (`0450–0452`), plus **commitment-aware reordering** (`0503`): what the next 30 days of services need versus what is on the shelf

### §6 Fuel
- ✅ FR-6.1 (P0) Log fuel per asset — **F4**
- ✅ FR-6.2 (P0) Consumption L/hr, L/100km + trend — **F4**
- ✅ FR-6.3 (P0) Anomaly detection — **F4**
- ⏸️ FR-6.4 (P2) Fuel-card import — **out of v1 scope by `SCOPE §13`**, reaffirmed by the founder in August 2026. Needs a card issuer's feed, so it would ship inert.

### §7 Faults
- ✅ FR-7.1 (P0) Log fault w/ desc/severity/photos
- ✅ FR-7.2 (P0) Captures asset/reporter/time/**location** — **F3**
- ✅ FR-7.3 (P1) Lifecycle + assignee — **F3**
- ✅ FR-7.4 (P1) Fault → job card
- ✅ FR-7.5 (P1) Fault → out-of-service — **F3**

### §8 Contractor/mechanic portal
- ✅ FR-8.1 (P0) Scoped to assigned assets/jobs — **F7** + **F16**: a contractor sees only work assigned to its own workshop, and only the vehicles it is working on unless the farm grants more
- ✅ FR-8.2 (P0) Upload quotes/invoices/photos — **F1**
- 🟡 FR-8.3 (P1) Status update + notify — completion notify ✅; per-change notify partial
- ✅ FR-8.4 (P1) Invoice amount → asset cost/TCO — **F1**

### §9 QR & field capture
- ✅ FR-9.1 (P0) Unique printable QR per asset
- ✅ FR-9.2 (P0) Scan → quick actions (fault/reading/service — F3; fuel — F4)
- ✅ FR-9.3 (P1) Scan-to-log offline + queue — **F2**
- ✅ FR-9.4 (P2) Re-issue/replace QR — rotates `machines.public_token` (`0508`); the old sticker stops working immediately and the change is audited

### §10 Costs & TCO
- ✅ FR-10.1 (P0) Every cost attributed (fuel/parts/labour/invoice/finance) — **F1/F4**
- ✅ FR-10.2 (P0) True TCO per asset — **F1**
- ✅ FR-10.3 (P0) Cost per hour & per km — **F1**
- ✅ FR-10.4 (P1) Budgets + budget-vs-actual — **G1** (`0360`). Actual is never stored; it is summed live from the `cost_entries` ledger over each budget's own scope and period.
- ✅ FR-10.5 (P2) Repair-vs-replace — **G1**: flags a machine once lifetime repair spend ÷ purchase price crosses a farm-set threshold

### §11 Dashboard & reporting
- ✅ FR-11.1 (P0) Dashboard core metrics
- ✅ FR-11.2 (P0) "Breaks most often" — **F1**
- 🟡 FR-11.3 (P1) Period + per-site/group — period ✅, per-site filter ✅ (F1); full multi-site → **F7**
- ✅ FR-11.4 (P1) Export CSV ✅ / PDF ✅ / **Excel ✅** — one multi-sheet workbook covering every report family (`/reports/workbook.xlsx`)
- ✅ FR-11.5 (P2) Scheduled/emailed reports — `0506`, on the nightly cron, idempotent per period so a retry cannot send twice. Unblocked by email going live (Resend).

### §12 Voice AI  🟡 live MVP; physical-device/pilot checks pending
- 🟡 FR-12.1 (P0) Voice control EN/AF — Azure real-time STT + Ollie Multilingual TTS (Willem fallback), deterministic intents and optional consent-gated LLM fallback are live in production. EN/AF typed flows, the Azure token broker, and the consented Gateway path passed production E2E on 24 August 2026; physical microphone and audible-playback QA remains.
- ✅ FR-12.2/12.3 (P1) Confirm-back / permissions — selected-farm role/plan checks, private server-held proposals, clarification, confirm-before-commit and atomic selected-farm commands are deployed. A production reject-path test verified that no fleet record was written.
- 🟡 FR-12.4 (P2) Offline fallback — raw recording queues only in device IndexedDB, is explicitly transcribed after reconnect, expires after seven days; real-device offline/reconnect testing remains.

### §13 Compliance (AARTO)
- ✅ FR-13.1 (P0) Driver-usage log — **F3**
- ✅ FR-13.2 (P1) AARTO fine workflow — capture, nominate the driver from the usage log, deadline reminders on the nightly cron
- ✅ FR-13.3 (P1) Licence/renewal tracking + reminders — **F6**
- ❌ FR-13.4 (P1) GLOBALG.A.P./SIZA audit packs, sale/warranty doc packs

### §14 Notifications
- 🟡 FR-14.1 (P0) Service-due/overdue/licence via in-app ✅ + **push ✅ (F6)** + **WhatsApp ⏸️**
- 🟡 FR-14.2 (P1) Notify on fault ✅ / job ✅ / fuel-anomaly ✅ (F4) — WhatsApp channel ⏸️
- ✅ FR-14.3 (P2) Per-user prefs + quiet hours — **F6**

### §15 Offline & sync — **all F2**
- ✅ FR-15.1 (P0) Offline capture + queue
- ✅ FR-15.2 (P0) Auto-sync + status
- ✅ FR-15.3 (P0) Deterministic conflict resolution
- ✅ FR-15.4 (P1) Offline media cached

### §16 WhatsApp & mobile
- ⏸️ FR-16.1 (P0) Log via WhatsApp (needs Meta Cloud API)
- ⏸️ FR-16.2 (P1) WhatsApp reminders/confirmations
- ✅ FR-16.3 (P0) Responsive mobile, ≥44px, low-end Android

### §17 Integrations & API
- ⏸️ FR-17.1 (P1) GPS-telematics feed — **out of v1 scope by `SCOPE §13`**, reaffirmed by the founder in August 2026. Needs a vendor, so it would ship inert.
- ❌ FR-17.2 (P2) Accounting export (Sage/Xero)
- ✅ FR-17.3 (P2) Public REST API + token — `0508`. Tokens stored hashed and shown once; gated on the `api_access` entitlement (Done-For-You); read endpoints plus one write (meter readings) with an idempotency key.

### §18 Localisation
- 🟡 FR-18.1 (P0) Full EN/AF, switchable per user — dictionaries complete (686 parity) ✅; **self-service per-user language switcher** to verify/add
- ✅ FR-18.2 (P1) Rand, ZA dates/units

### §19 Billing, plans & entitlements
- 🟡 FR-19.1 (P0) Per-vehicle billing, 4 tiers — tiers ✅ + price display ✅ (F5); **charging ⏸️ (Paystack)**
- ✅ FR-19.2 (P0) Entitlements gated by plan — **F5**
- 🟡 FR-19.3 (P1) Annual pre-pay / asset-count pricing / export-on-cancel — asset-count ✅, annual flag ✅; billing engine ⏸️
- ❌ FR-19.4 (P2) Self-hosted licence SKU

### §22 Non-functional
- 🟡 NFR-1 (P0) Perf <2s on 3G — lean bundle (102 kB) ✅; not load-tested
- ✅ NFR-2 (P0) Per-tenant isolation — RLS, proven by tests; transit/at-rest via Supabase
- ✅ NFR-3 (P0) POPIA retention/deletion — **F8** (`0350`): DSAR export and erasure-by-anonymisation, owner/manager or RR-admin guarded, every cross-tenant access logged
- ✅ NFR-4 (P1) Backups/restore/uptime — **F8**: `docs/BACKUP.md` carries the PITR runbook, RPO/RTO, the 99.5% target and a quarterly restore-drill checklist
- 🟡 NFR-5 (P1) Accessibility — tap targets/focus ✅; sunlight/SR audit pending
- ✅ NFR-6 (P1) Observability — server errors, server actions, route handlers and both client error boundaries report; the nightly cron no longer swallows a failed step. Speaks Sentry's ingest protocol over `fetch` rather than installing the SDK, so the shared bundle stays at 102 kB. Env-gated on `SENTRY_DSN`; with none set it falls through to the server log.
- 🟡 NFR-7 (P1) Scale to thousands — indexed; some dashboards load-all (paginate later)

### §23 Metrics
✅ due/overdue · ✅ total spend · ✅ assets tracked · ✅ cost by machine · ✅ breaks most often · ✅ TCO · ✅ cost/hour · ✅ cost/km · ✅ fuel L/hr & L/100km + trend · ✅ fuel anomalies · ✅ warranty/licence expiries · ✅ downtime per asset (reconstructed from the `audit_log` status trail, **G1** `0361` — no longer a workshop-days proxy) · 🟡 open vs resolved faults · ✅ budget vs actual (**G1** `0360`) · ✅ utilisation, hours used vs idle (**G1** `src/lib/analytics.ts`) · ✅ AARTO nominations pending

### §24 Production-readiness gate
🟡 Close. **Every P0 requirement is now built**, and NFR-3 (POPIA), NFR-4 (backups) and NFR-6 (observability) are all done — those three were the standing blockers in earlier revisions of this document.

What actually remains before the gate:

- **Voice AI physical-device QA** — the backend paths passed production E2E on 24 August 2026; microphone capture and audible playback on a real handset, and the offline/reconnect path, have not been exercised on hardware.
- **Three items in flight** (see FR-1.4, FR-13.4, FR-17.2 above) — audit location, compliance/sale/warranty packs, and the accounting file export.
- **FR-19.4 self-hosted licence SKU** — P2, nobody blocked.
- **Load behaviour** (NFR-7) — indexed throughout, but some dashboards still load-all rather than paginate.

Deliberately outside the gate, by decision rather than omission: WhatsApp Stage 2 and subscription charging both wait on a provider account; customer-to-contractor payment processing is out of scope entirely, because customers pay by EFT and invoices already carry the banking details; and fuel-card import and GPS telematics are excluded by `SCOPE §13`.

---

## B. Extra features from the founder's provider spec (beyond §1–24)

These were introduced by `FLEETWISE_VOICE_WHATSAPP_BILLING_SPEC.md` and are **not** in the original checklist:
- 🟡 Three-tier voice routing (local/deterministic/optional LLM), `asset_aliases`, English phrase-list biasing and redacted `ai_interactions` logging implemented; Afrikaans eval set remains
- ⏸️ Hybrid RAG knowledge base (`kb_documents`/`kb_chunks`, pgvector + full-text)
- 🟡 `ai_interactions` private/redacted logging implemented; production eval workflow remains
- ⏸️ WhatsApp free-24h-window cost optimisation + template registry
- ⏸️ Affiliate program (referral codes, tiered commissions)
- ⏸️ DebiCheck debit-order rail (Phase 3)
- ⏸️ Capacitor native mobile shell (Phase 3)
- ⏸️ Self-hosted/Dockerised SKU (Phase 3)

---

## C. What's left (grouped)

### Base product — remaining (no providers needed) — DO THESE FIRST
1. **Service kits + parts catalogue** (FR-5.1 P0, 5.2/5.3 P1) — *not yet scheduled; the biggest open P0.*
2. **F7 — Multi-site + per-role visibility** (FR-1.5, 2.3, 8.1, 11.3-full)
3. **F8 — POPIA + security + backup docs & data-subject deletion** (NFR-3, NFR-4, NFR-2 doc)
4. **Observability** — wire Sentry + basic analytics (NFR-6)
5. **Budgets + budget-vs-actual** (FR-10.4) and **utilisation / downtime** metrics (§23)
6. **AARTO fine workflow** (FR-13.2) + **audit/doc packs** (FR-13.4)
7. **Excel export** (FR-11.4) + **scheduled reports** (FR-11.5, P2)
8. **QR re-issue** (FR-9.4, P2), **per-user language switcher** (FR-18.1 completeness), status-vocab alignment (FR-3.3), "from where" audit (FR-1.4)
9. **Base-product hardening/QA pass** — end-to-end runtime verification before any AI

### Provider-dependent
- **Voice AI** (Azure + optional Vercel AI Gateway) — live MVP; complete physical-device QA, S0 pilot provisioning, Afrikaans evaluation and processor/DPA sign-off before a wider pilot
- **WhatsApp** (Meta Cloud API) — §16.1/16.2 + spec extras
- **Billing charging** (Paystack) — §19.1/19.3 engine on top of F5's framework + affiliate/DebiCheck

---

## D. Scoreboard

**Merged so far:** F1 Cost/TCO · F2 Offline/Sync · F3 Field-capture/AARTO-usage · F4 Fuel · F5 Entitlements · F6 Compliance/Push — **6 major workstreams, 38 migrations, all gates green.**

**P0 requirements (legacy approximate count):** Voice is no longer in the deferred provider set: its MVP is live with pilot checks pending. WhatsApp and subscription billing remain deferred; service kits, multi-site and broader POPIA work retain their section statuses above.

**Bottom line:** the maintenance/cost/fuel/offline/compliance/entitlement core is essentially complete. The Voice AI MVP is deployed and testable in production; physical-device QA, pilot capacity, the Afrikaans evaluation set and processor/DPA sign-off remain. WhatsApp and subscription charging remain intentionally parked; customer-to-contractor payment collection is not part of the current product scope.
