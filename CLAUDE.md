# FarmGear — Farm Machinery & Vehicle Manager

Multi-tenant PWA for South African farms to manage machinery: registry, QR codes,
service scheduling, job cards, faults, costs, dashboards, WhatsApp alerts.
**Read [`docs/SCOPE.md`](docs/SCOPE.md) in full before planning any feature** — it is the source of truth.

## Stack
- **Next.js (App Router) PWA** + TypeScript + Tailwind — mobile-first (mid-range Android).
- **Supabase** (Postgres + Auth + Storage) with **row-level security** for multi-tenancy.
- Migrations = plain SQL files in `supabase/migrations/` (Supabase-compatible; also run against a local Postgres for tests).
- Deploy target: Vercel (app) + Supabase cloud. (Not wired in Week 1.)

## Commands
```bash
pnpm install            # install deps
pnpm dev                # run app (needs .env.local — see .env.example)
pnpm build              # production build
pnpm typecheck          # tsc --noEmit
pnpm lint               # next lint
pnpm db:test            # apply migrations + run RLS isolation tests on local Postgres
```
`pnpm db:test` runs `supabase/tests/run.sh`: it (re)creates a local test DB, loads the
Supabase auth shim, applies every migration in order, then runs the RLS isolation suite.

## Key conventions & decisions
- **Tenancy first.** Every business table carries `farm_id` (denormalized, enforced by composite FKs).
  RLS is the *sole* guarantor of cross-tenant + external-workshop isolation and is proven by tests
  (`supabase/tests/rls_isolation.sql`) before any feature is built on top.
- **RLS model:** app role/farm live in `public.users` (PK = `auth.users.id`). Helper fns in schema `app`
  (`is_rr_admin()`, `accessible_farm_ids()`, `has_farm_access(farm_id)`) drive every policy.
  Workshop staff reach farms via `workshop_links` (status=active). RR admin = cross-tenant (logged).
- **Money** stored as **integer cents, ex-VAT**; `vat_rate` captured. No floats near money.
- **History is structural:** soft delete (`deleted_at`/`deleted_by`), append-only `audit_log` (trigger),
  job cards lock after approval (trigger blocks edits; history via audit diffs).
- **Public QR flow has ZERO anon DB access.** QR encodes an unguessable per-machine `public_token`;
  submissions go through service-role server routes that validate the token.
- **Auth (v1):** email (password + magic-link) + email invites; workers use the no-login QR page.
  Phone/WhatsApp/SMS auth deferred (WhatsApp Stage 2).
- **i18n from day one:** all UI strings in `src/lib/i18n/en.json` (filled) + `af.json` (keys ready for
  the Week 3 Afrikaans pass). Minimal `t()` helper — no heavy i18n lib (bundle size).
- **Out of scope for v1** (Scope §13) is a hard NO: GPS/telemetry, anomaly ML, parts inventory,
  invoicing/accounting, crop/livestock/labour, store apps, full offline sync, >2 languages.

## Build plan (Scope §10) — current status
**Phase: v1 backend complete (Weeks 1–3).** Deployed to production on Vercel (`main`).

Done:
- Repo skeleton; scope at `docs/SCOPE.md`.
- Full Section 6 schema (incl. v1.5 fuel tables); money-in-cents, soft-delete, audit
  trigger, job-card lock + totals triggers. `supabase/migrations/0001–0008`.
- RLS helpers + policies for **every** table; **green isolation tests** (`pnpm db:test`).
  `0100–0102`, `0200` (storage buckets).
- CI: migrations + isolation suite **and** app typecheck/build (`.github/workflows/ci.yml`).
- Next.js PWA scaffold (App Router, Tailwind, i18n en/af + `t()`, Supabase clients,
  session middleware). Builds clean; home ~105 KB.
- Demo-farm seed: 12 machines with realistic histories (`pnpm db:seed`).
- **App layer (runtime-verified against the live DB):**
  auth (email + magic-link, `/auth/callback`, session guards, `lib/auth.ts`);
  RR admin console (`/admin/farms` create + tier/status, farm detail);
  machine registry CRUD (`/machines` list/filter/search, new, edit);
  meter readings (capture + current-reading advance, farm-scoped);
  machine photos (client-side compression → Storage, farm-scoped `storage.objects`
  RLS in `0201`). Verified as owner `danie@weltevrede.example` (all dev logins:
  `FarmGear!dev1`).
- README with Vercel deploy env-var notes.
- **Hosted Supabase wired + verified.** Project `nmqtcvdwtyggxjjgtnzm` (repurposed the
  org's spare; cleared an old restaurant demo). Migrations + Storage buckets + demo seed
  applied; security advisors clean bar the optional leaked-password toggle. Verified via
  REST against the live project: login works, RLS scopes correctly (rr_admin sees all,
  anon denied), `/dashboard` guarded, job-card money triggers correct. `.env.local`
  wired (gitignored). Dev RR-admin: `admin@farmgear.dev`.

- **Week 2–3 backend (migrations 0202–0204; verified live + isolation-tested):**
  service **due engine** (`app.recalc_machine_service`/`recalc_all_due`, meter trigger);
  **job cards** end-to-end (create/lines/complete/approve→lock, completion side-effects:
  service-line reset, meter capture, watch item, fault resolve); **faults** (in-app +
  QR, fault→job); **watch items**; **dashboard** (service board/spend/faults/stale);
  **reports** 1–4 + cost CSV; **notifications** queue (fault/job triggers) + in-app centre;
  **users/invites** (Auth admin) + deactivate; **settings** RPC (owner-editable).

- **UI/UX rework + v1 completion (this mission — branch `claude/farmgear-ui-ux-backend-th78c7`):**
  - **Design system**: tokens (brand/`sand` scales around the traffic-light `status.*`),
    responsive app shells (mobile bottom-tab + "More" sheet; desktop sidebar + top bar),
    and an accessible UI kit in `src/components/ui/**` (Button/Field/Card/Table/Badge/
    StatusPill/Stat/Modal/Sheet/Toast/Tabs/EmptyState/Skeleton/icons). Server pages import
    kit pieces from direct module paths to keep bundles flat (see kit README).
  - **Every surface reworked** on the kit with mobile+desktop treatments, empty/loading/
    error states, and `t()`: **dashboard** (KPIs, 6-month spend trend + breakdowns, actionable
    faults, drill-downs); **machines** (cards/table, filters/search/sort, **bulk CSV import**);
    **machine detail** (identity, SVG meter graph, **service-plan CRUD + apply-template**,
    chronological **history timeline**, lifetime stats, QR print sheet); **job cards**
    (mobile-fast entry, **draft autosave**, **VAT-inclusive entry** → ex-VAT cents, lock
    affordance, confirm modals); **faults + public QR** (common-fault buttons, photo +
    **voice-note** capture; public path stays anon-DB-free via service-role routes); **reports**
    (4 families, period filter, print CSS, **CSV per family**); **team/settings/notifications**;
    **admin** (usage stats, logged impersonation, template library); **auth + onboarding checklist**.
  - **New backend**: `0205` service-due notifications (due-soon/overdue, weekly digest,
    stale-meter nudge) honouring thresholds + quiet hours (`deliver_after`), **nightly cron**
    (`/api/cron/nightly`, `vercel.json`, `CRON_SECRET`; see `docs/CRON.md`); `0206` admin
    impersonation audit RPC; `0207` fault-voice Storage bucket. All isolation-tested; `db:test` green.
  - **PDFs** (`pdf-lib`, server-route-only): job-card PDF + machine-file "service book" PDF.
  - **Afrikaans**: `af.json` fully translated (429 keys at parity with `en.json`).
  - **Retired/sold machines** excluded from every dashboard/report/alert count and the
    notification engine (Scope §4.1 / C8).
  - Gates green (typecheck + lint + build + `db:test`); shared first-load JS flat at **102 kB**.

Remaining (Week 4 + v1.5):
- WhatsApp Stage 2 (BSP API) — Stage 1 manual; in-app centre + `deliver_after` queue ready.
- Wire the nightly cron in the Vercel project + set `CRON_SECRET` (route + docs shipped).
- v1.5 diesel/fuel module (tables + RLS exist; no features) — out of v1 scope.
- Runtime click-through against the live DB (this session verified boot/render/guards with
  placeholder env; `.env.local` with live creds was absent in the fresh clone).

Env/dashboard follow-ups: delete the empty `menu-media` bucket; optional Auth
leaked-password protection. Dev logins: `admin@farmgear.dev`, `danie@weltevrede.example`
(both `FarmGear!dev1`).

- **FleetWise F1 — Cost & TCO spine (migrations `0210–0211`; branch
  `claude/fleetwise-cost-tco-spine`; isolation-tested, `db:test` green):**
  - `cost_entries` ledger (types purchase/finance/fuel/parts/labour/invoice/other,
    ex-VAT cents, nullable `machine_id` for farm-level fuel, composite FK, full RLS +
    grants + audit). SECURITY-DEFINER sync triggers keep it in step with
    `job_card_lines` (parts/labour/other), `machines` (purchase price + derived finance
    interest) and `fuel_deliveries` (farm-level fuel); idempotent backfill for existing
    rows. `app.machine_tco()` rollup. Machine finance fields added.
  - App: real **TCO** on machine detail (+ cost breakdown + finance card) and **ranked
    by TCO** in reports; **cost-per-hour & cost-per-km on a consistent lifetime basis**
    (shared `src/lib/cost.ts`, fixes D-2/D-3 — detail and reports now agree); true
    per-machine **"breaks most often"** (FR-11.2) + **per-site/group** report filter
    (FR-11.3, graceful pre-F7); job-card **quote/invoice/photo upload** with invoice
    amount → `invoice` cost entry (FR-8.4, service-role media route + `jobcard-photos`).
  - Rename **FarmGear → FleetWise** across touched UI/metadata (layout, manifest,
    `env.APP_NAME`, i18n `app.name`, README, PDF wordmark). i18n EN/AF at parity
    (466 keys). Bucket ids + `farmgear:` localStorage prefixes kept stable.

- **FleetWise F4 — Fuel module (migrations `0240–0242`; branch
  `claude/fleetwise-fuel`; isolation-tested, `db:test` green):**
  - Fuel-cost model = **per-issue attribution** (no double-count): fuel enters the
    TCO ledger ONLY via `fuel_issues` (per-machine `fuel` cost_entry, `machine_id`
    null → farm-level); the F1 `0211` `fuel_delivery`→cost trigger is **replaced** to
    book nothing (deliveries are tank stock) and to soft-delete any pre-existing
    delivery-sourced fuel entry. Result: a farm's fuel appears in `cost_entries`
    **exactly once** — asserted in `rls_isolation.sql` (F4 section). Capture columns
    added to `fuel_issues` (`cost_cents`, `price_per_l_cents`, `vat_rate_bps`,
    `driver_name`, `anomaly_notified_at`) + `fuel_deliveries` (`vat_rate_bps`,
    `by_user`); RLS/audit/grants already covered these tables (0101/0008/0102).
  - **Consumption engine**: `app.machine_fuel_consumption` (interval/brim-to-brim,
    L/hr for hours, L/100km for km) mirrored client-side in `src/lib/fuel.ts` so UI ==
    SQL. **Anomaly engine** `app.enqueue_fuel_anomalies` (rolling-baseline leak/theft;
    thresholds `fuel_anomaly_pct`/`fuel_anomaly_min_history`; retired/sold excluded;
    quiet hours honoured; owner/manager `fuel_anomaly` notify; dedupe via
    `anomaly_notified_at`) + `public.cron_enqueue_fuel_anomalies` wired into the
    nightly cron.
  - App: **/fuel** section (tanks + reconciliation, delivery + per-machine draw
    capture, per-machine consumption with trend sparkline, flagged anomalies, recent
    lists); **QR "log fuel"** quick action finishing the F3 placeholder (token-gated
    service-role, zero anon-DB, auto-creates a default tank); machine-detail **Fuel &
    consumption** card + quick draw; **dashboard** fuel card; **reports** fuel section
    + `fuel.csv`; **settings** anomaly thresholds. Draws write a driver `usage_log`
    when operator + meter are known (FR-13.1). Cost entered VAT-inclusive → stored
    ex-VAT cents. Fuel nav item + icon. Demo seed gains a tank, deliveries and draws
    (one anomaly). i18n EN/AF at parity (**610 keys**). Gates green (typecheck + lint
    + build + `db:test`); shared first-load JS flat at **102 kB**.

> Update this "current status" block at the end of every session.
