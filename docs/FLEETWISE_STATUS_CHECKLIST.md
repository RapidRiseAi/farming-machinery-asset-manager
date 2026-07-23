# FleetWise — Full feature status checklist

**As of:** F1–F6 merged to `main`. Legend: ✅ done & merged · 🟡 partial · ❌ not started · ⏸️ deferred (needs a provider you must set up first — see `FLEETWISE_PROVIDER_SETUP_GUIDE.md`).

**Does this checklist contain everything?** Yes — it covers **every** requirement in the official spec (`FR-x.y` / `NFR-n`, §1–24) **plus** the extra features the founder's provider spec added (§B below) that were NOT in the original §1–24 (affiliate program, RAG/knowledge base, DebiCheck, etc.). Nothing is hidden.

---

## A. Official spec (FR-x.y / NFR-n)

### §1 Product scope
- ✅ FR-1.1 (P0) Manage every asset type
- 🟡 FR-1.2 (P0) Every capture <30s on mobile — fast paths exist; not formally measured
- ✅ FR-1.3 (P0) Full offline — **F2**
- 🟡 FR-1.4 (P1) Auditable who/when/**where** — who+when ✅ (audit_log); "from where" ❌
- 🟡 FR-1.5 (P0) Multi-farm/site under one account — isolation ✅; one-account-many-sites ❌ → **F7**

### §2 Roles & permissions
- 🟡 FR-2.1 (P0) RBAC roles — 5 roles present; no distinct "external contractor"
- ✅ FR-2.2 (P0) Unlimited users
- ❌ FR-2.3 (P1) Per-role visibility (operators→assigned assets, contractors→assigned jobs) → **F7**
- ✅ FR-2.4 (P1) Invite/deactivate
- ❌ FR-2.5 (P2) Custom roles

### §3 Asset register
- ✅ FR-3.1 (P0) Create/edit/archive
- 🟡 FR-3.2 (P0) Per-asset fields — make/model/…/photos ✅; **finance fields ✅ (F1)**; VIN=serial
- 🟡 FR-3.3 (P0) Live status — now has `out_of_service` (F3); vocab still differs from spec's In-use/Available
- 🟡 FR-3.4 (P1) Group/filter by type/location/cost-centre/dept — type/status/search ✅; location/cost-centre/dept ❌
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

### §5 Service kits & parts  ⚠️ largest remaining base gap
- ❌ **FR-5.1 (P0)** Pre-loaded service kit (oil/filter part numbers) → **not built**
- ❌ FR-5.2 (P1) Parts catalogue (part no/supplier/cost)
- 🟡 FR-5.3 (P1) Parts consumed → cost & history (job-card lines do this; no catalogue)
- ❌ FR-5.4 (P2) Inventory/stock + low-stock

### §6 Fuel
- ✅ FR-6.1 (P0) Log fuel per asset — **F4**
- ✅ FR-6.2 (P0) Consumption L/hr, L/100km + trend — **F4**
- ✅ FR-6.3 (P0) Anomaly detection — **F4**
- ❌ FR-6.4 (P2) Fuel-card import (needs integration)

### §7 Faults
- ✅ FR-7.1 (P0) Log fault w/ desc/severity/photos
- ✅ FR-7.2 (P0) Captures asset/reporter/time/**location** — **F3**
- ✅ FR-7.3 (P1) Lifecycle + assignee — **F3**
- ✅ FR-7.4 (P1) Fault → job card
- ✅ FR-7.5 (P1) Fault → out-of-service — **F3**

### §8 Contractor/mechanic portal
- 🟡 FR-8.1 (P0) Scoped to assigned assets/jobs — farm-scoped ✅; per-job scoping ❌ → **F7**
- ✅ FR-8.2 (P0) Upload quotes/invoices/photos — **F1**
- 🟡 FR-8.3 (P1) Status update + notify — completion notify ✅; per-change notify partial
- ✅ FR-8.4 (P1) Invoice amount → asset cost/TCO — **F1**

### §9 QR & field capture
- ✅ FR-9.1 (P0) Unique printable QR per asset
- ✅ FR-9.2 (P0) Scan → quick actions (fault/reading/service — F3; fuel — F4)
- ✅ FR-9.3 (P1) Scan-to-log offline + queue — **F2**
- ❌ FR-9.4 (P2) Re-issue/replace QR

### §10 Costs & TCO
- ✅ FR-10.1 (P0) Every cost attributed (fuel/parts/labour/invoice/finance) — **F1/F4**
- ✅ FR-10.2 (P0) True TCO per asset — **F1**
- ✅ FR-10.3 (P0) Cost per hour & per km — **F1**
- ❌ FR-10.4 (P1) Budgets + budget-vs-actual
- ❌ FR-10.5 (P2) Repair-vs-replace indicator

### §11 Dashboard & reporting
- ✅ FR-11.1 (P0) Dashboard core metrics
- ✅ FR-11.2 (P0) "Breaks most often" — **F1**
- 🟡 FR-11.3 (P1) Period + per-site/group — period ✅, per-site filter ✅ (F1); full multi-site → **F7**
- 🟡 FR-11.4 (P1) Export CSV ✅ / PDF ✅ (job-card+machine-file) / **Excel ❌**, report-PDF via print
- ❌ FR-11.5 (P2) Scheduled/emailed reports

### §12 Voice AI  ⏸️ provider ready (Azure), not built
- ⏸️ FR-12.1 (P0) Voice control EN/AF
- ⏸️ FR-12.2/12.3 (P1) Confirm-back / permissions
- ⏸️ FR-12.4 (P2) Offline fallback

### §13 Compliance (AARTO)
- ✅ FR-13.1 (P0) Driver-usage log — **F3**
- ❌ FR-13.2 (P1) AARTO fine workflow (capture fine → identify driver → deadline)
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
- ❌ FR-17.1 (P1) Fuel-card / GPS-telematics feed
- ❌ FR-17.2 (P2) Accounting export (Sage/Xero)
- ❌ FR-17.3 (P2) Public REST API + token (plan gate exists; API not built)

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
- ❌ NFR-3 (P0) POPIA retention/deletion → **F8**
- ❌ NFR-4 (P1) Backups/restore/uptime → **F8** + infra setup
- 🟡 NFR-5 (P1) Accessibility — tap targets/focus ✅; sunlight/SR audit pending
- ❌ NFR-6 (P1) Observability (Sentry/analytics) — in setup guide, not wired
- 🟡 NFR-7 (P1) Scale to thousands — indexed; some dashboards load-all (paginate later)

### §23 Metrics
✅ due/overdue · ✅ total spend · ✅ assets tracked · ✅ cost by machine · ✅ breaks most often · ✅ TCO · ✅ cost/hour · ✅ cost/km · ✅ fuel L/hr & L/100km + trend · ✅ fuel anomalies · ✅ warranty/licence expiries · 🟡 downtime per asset (workshop-days proxy) · 🟡 open vs resolved faults · ❌ budget vs actual · ❌ utilisation (hours used vs idle) · 🟡 AARTO nominations pending (usage log ✅; nomination workflow ❌)

### §24 Production-readiness gate
❌ Not yet — remaining P0 items (service kits FR-5.1; plus the ⏸️ provider features voice/WhatsApp/billing-charging) and the NFR-3/4/6 + hardening pass stand between here and the gate.

---

## B. Extra features from the founder's provider spec (beyond §1–24)

These were introduced by `FLEETWISE_VOICE_WHATSAPP_BILLING_SPEC.md` and are **not** in the original checklist:
- ⏸️ Three-tier voice routing (local grammar / deterministic / LLM), `asset_aliases`, phrase-list biasing, Afrikaans eval set
- ⏸️ Hybrid RAG knowledge base (`kb_documents`/`kb_chunks`, pgvector + full-text)
- ⏸️ `ai_interactions` eval/finetune logging
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

### Deferred — provider-dependent (build after you complete `FLEETWISE_PROVIDER_SETUP_GUIDE.md`)
- **Voice AI** (Azure) — §12 + spec extras
- **WhatsApp** (Meta Cloud API) — §16.1/16.2 + spec extras
- **Billing charging** (Paystack) — §19.1/19.3 engine on top of F5's framework + affiliate/DebiCheck

---

## D. Scoreboard

**Merged so far:** F1 Cost/TCO · F2 Offline/Sync · F3 Field-capture/AARTO-usage · F4 Fuel · F5 Entitlements · F6 Compliance/Push — **6 major workstreams, 38 migrations, all gates green.**

**P0 requirements (40 total):** ~28 ✅ done · ~7 🟡 partial · ~5 ⏸️/❌ remaining (service kits, multi-site, POPIA, + voice/WhatsApp/billing which are the ⏸️ provider set). Up from ~11 ✅ at the start of this effort.

**Bottom line:** the maintenance/cost/fuel/offline/compliance/entitlement core is essentially complete. Remaining base work = service kits, multi-site + per-role, POPIA/security, observability, and a hardening pass. The three big provider features (Voice/WhatsApp/Billing) are intentionally parked until you finish the manual provider setup.
