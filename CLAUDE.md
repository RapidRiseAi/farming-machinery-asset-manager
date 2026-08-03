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

- **FleetWise F5 — Plans & entitlement gating framework (migrations `0250–0251`;
  branch `claude/fleetwise-entitlements`; isolation-tested, `db:test` green;
  PAYMENTS DEFERRED):**
  - **Plans**: replace `farm_tier` (starter/standard/large) with `farm_plan`
    **essential/professional/complete/done_for_you**. Data map applied in `0250`:
    starter→essential, standard→professional, large→complete (done_for_you = new
    top plan; default 'essential'). Subscription shape on `farms`: `plan`,
    `billing_period` (monthly/annual enum), maintained `asset_count` (+ existing
    `status`). Tenancy/RLS/audit unchanged (farms only reshaped).
  - **Entitlement map** = single source of truth `src/lib/entitlements.ts`, mirrored
    by SQL `app.has_entitlement(farm, feature)` (+ `public.has_entitlement` wrapper),
    `app.plan_rank`/`app.feature_min_rank` (0251, SECURITY DEFINER, revoked from
    public/anon). Gates per FR-19.2: **dashboard/advanced_reports/fuel/tco =
    Professional+**, **aarto/voice_ai/multi_site/whatsapp = Complete+**, **api_access
    = Done-For-You**; unlisted features are ungated core. `has_entitlement` also
    guards cross-tenant probing (returns false without farm access).
  - **Server-side enforcement** via `requireEntitlement(feature)` / `checkEntitlement`
    / `currentPlan` in `lib/auth.ts` (rr_admin + workshop bypass). Gated **at the
    route/action, not just hidden**: dashboard, reports (+ all report CSV routes →
    403), fuel page + `addFuel*` actions + the **public QR fuel action** (service-role
    plan check), and the machine-detail **fuel (Prof+)** + **AARTO (Complete+)** panels.
    Denied surfaces render a server-side `UpgradeNotice`; nav hides gated items and the
    logo falls back to `/machines` when dashboard is gated.
  - **Admin** (`admin/farms` list + `[id]`): 4-plan + billing-period selects, plus
    **asset count** and **per-vehicle price DISPLAY ONLY** (VAT-INCLUSIVE per founder
    decision — indicative monthly/annual subtotal shown; **no charging**).
  - **Billing seam** `src/lib/billing/*`: `BillingAdapter` interface + env-gated
    (`BILLING_PROVIDER`) **no-op adapter** returning `{deferred:true}` — clean plug-in
    point for the provider chosen after research. No real provider wired.
  - Demo seed farm set to **Complete/annual** so every gated surface demos. i18n EN/AF
    at parity (**628 keys**; `plan.*`, `billingPeriod.*`, `upgrade.*`). `rls_isolation.sql`
    F5 section proves plan gating, cross-tenant isolation, anon-deny, and the
    asset-count trigger. Gates green (typecheck + lint + build + `db:test`); shared
    first-load JS flat at **102 kB**.
- **FleetWise F6 — Compliance reminders & Web Push (migrations `0260–0263`; branch
  `claude/fleetwise-compliance-push`; isolation-tested, `db:test` green):**
  - **`licences`** table (per-machine renewals: vehicle-licence/roadworthy/permit/
    crossborder/insurance/other, number, `expiry_date`, `reminder_lead_days`, notes)
    with `expiry_status` + `licence_type` enums; farm-scoped RLS + composite FK + grants
    + audit + soft-delete + notify dedupe columns. Warranty already on `machines`; `0260`
    adds `warranty_notified_status/_at` for engine dedupe.
  - **Expiry engine** (`0263`, 0205-pattern): `app.enqueue_expiry_notifications`
    (warranty date **and** hours basis + licences) honouring per-farm thresholds
    (`warranty_lead_days`/`warranty_hours_lead`/`licence_lead_days`), quiet hours, weekly
    re-fire dedupe; retired/sold excluded; `public.cron_*` wrapper wired into the nightly
    route. Templates `warranty_expiring/_expired`, `licence_expiring/_expired`.
  - **Web Push** (self-hosted VAPID, no provider): `push_subscriptions` table (own-user
    RLS + audit); `src/lib/push/webpush.ts` (VAPID JWT ES256 + RFC 8291/8188 aes128gcm via
    Node crypto only); `deliverPush` (per-user `notify_push`, dedupe via
    `notifications.push_sent_at`, prunes dead endpoints); routes `/api/push/{subscribe,
    unsubscribe,send}`; `public/sw.js` gains `push` + `notificationclick` (F2 offline logic
    intact); nightly cron delivers after enqueues; env-gated (no-op if VAPID unset;
    `.env.example` + `scripts/gen-vapid-keys.mjs`).
  - **Per-user prefs** (FR-14.3): `users.notify_inapp/notify_push/quiet_hours_*` +
    `set_notification_prefs` RPC; prefs-aware `notify_farm` (both overloads). Preferences
    UI + PushToggle on the alert centre; shared `formatNotification` renders expiry/push
    templates in-app + push.
  - App: machine-detail **Compliance card** (warranty + licence CRUD w/ status badges);
    **dashboard "Expiries upcoming"**; farm **expiry-lead settings**. i18n EN/AF at parity
    (**668 leaf keys**). Gates green (typecheck + lint + build + `db:test`); shared
    first-load JS flat at **102 kB**.

- **FleetWise F10 — Vehicle capture completeness + images (migration `0280`; branch
  `claude/fleetwise-vehicle-capture`; isolation-tested, `db:test` green):**
  - **Primary vehicle image**: `machines.primary_attachment_id` — a **composite FK** to
    `attachments(id, farm_id)` so a machine can only point at a photo of its OWN farm
    (nullable → graceful placeholder). Rendered on the **machines list** (cards + a new
    desktop thumbnail column, batch-signed URLs) and the **detail header** (signed URL,
    placeholder fallback). `MachinePhotos` reworked into a gallery with **set/unset
    primary** (server actions + `revalidatePath`; primary-first ordering, ring + badge)
    and full i18n/locale.
  - **Full capture on add** (FR-3.2/3.4): `cost_centre` + `department` capture columns
    added to `machines`, `MachineFields` (new "Grouping" section), `createMachine`/
    `updateMachine`; shown in the detail identity card; added as **distinct-value dropdown
    filters** on the machines list. **Primary photo upload during add** — a client-
    compressed base64 data URL ferried through `createMachine`, uploaded via the RLS
    server client and marked primary (`serverActions.bodySizeLimit` → 4 MB). Finance
    (F1) + warranty/licence (F1/F6) + assigned operator (F3) capture kept intact.
  - Shared client `src/lib/image-compress.ts`; server `src/lib/machine-photo.ts` uploader;
    demo seed gains cost-centre/department. i18n EN/AF at parity (**698 leaf keys**).
    `rls_isolation.sql` F10 section proves the primary reference stays farm-isolated
    (composite-FK cross-farm reject) + capture-column tenant isolation. Storage stays
    farm-scoped (`{farm_id}/{machine_id}/…`, signed URLs); anon zero-DB unchanged. Gates
- **FleetWise F9 — Service kits & parts catalogue (migrations `0270–0271`; branch
  `claude/fleetwise-service-kits`; isolation-tested, `db:test` green):**
  - **`parts_catalogue`** (part_no, description, supplier, category, `typical_cost_cents`
    ex-VAT, nullable `farm_id` = GLOBAL/RR-seeded row) — tenancy mirrors `service_templates`
    (global rows readable by all authenticated; per-farm rows RLS-scoped) + grants + audit +
    soft-delete. Manual CRUD at **/parts** (owner/manager/mechanic for their farm; RR admin
    for the global library), with search + VAT-inclusive→ex-VAT capture.
  - **`service_kits`** (per machine, or a machine_type template; scope check enforces one)
    **+ `service_kit_items`** (catalogue-part ref or free part_no + qty + ex-VAT unit cost);
    farm-scoped RLS + composite FK + audit + soft-delete. Machine-detail **"Service kit"
    card**: create kit, add/edit/remove items (pick from catalogue → snapshot, or free part).
  - **"Add from catalogue"** on job-card line entry (prefills part_no/description/ex-VAT cost)
    + **"Apply kit"** on a job card → appends one `job_card_line` per item; those flow to
    `cost_entries`/TCO + history via the **existing 0211 trigger** (the ONLY kit→cost path —
    **no double-count**, asserted in `rls_isolation.sql` F9 section). Parts nav item + icon;
    demo seed gains a catalogue + a 250h kit. i18n EN/AF at parity (**724 leaf keys**). Gates
    green (typecheck + lint + build + `db:test`); shared first-load JS flat at **102 kB**.

- **FleetWise F12a — Contractor spine & Partners directory (migrations `0300–0301`;
  branch `claude/fleetwise-contractor-spine`; isolation-tested, `db:test` green):**
  - **Contractor typing on the existing workshop spine**: `contractor_kind` enum
    (mechanic/auto_electrician/parts_supplier/panel_beater/tyre/towing/other) + structured
    contact columns (`phone`/`whatsapp`/`email`/`area`) added to `workshops` (0300; additive,
    default kind 'other'; existing 0101 RLS + 0008 audit unchanged). A contractor/supplier
    stays a `workshop`; staff are `workshop`-role users reaching linked farms via
    `workshop_links` (the one-account→many-farms spine — extended, not replaced).
  - **`partners`** table (0301): find/add/quick-contact/connect directory. Tenancy mirrors
    `service_templates`/`parts_catalogue` — GLOBAL suggested rows (`farm_id` null,
    `is_suggested` true, RR-curated) readable by all authenticated; farm-owned rows via
    `app.has_farm_access`. **Mutation restricted to the owning farm's owner/manager (or RR
    admin for globals)** via `app.current_app_role()` in the policies. `(farm_id IS NULL) =
    is_suggested` check-constraint invariant; nullable `workshop_id` link (set once joined);
    grants + audit + soft-delete; anon zero-DB.
  - **Invite / connect flow** (`inviteContractor`, service-role — workshops/users are
    RR-admin-only under RLS): from a farm-owned partner, owner/manager creates/reuses a
    `workshop` (carrying the partner's kind + contacts), an **active** `workshop_link` to the
    farm, a confirmed `workshop`-role user, and a **magic login URL** (`auth.admin.generateLink`)
    to hand over — deep-links to `/auth/callback?next=/machines`. Idempotent (reuses the linked
    workshop, re-activates a revoked link, skips existing profiles). No guessable bypass —
    access remains RLS + `workshop_links`. `sendLoginUrl` re-issues a link for a connected
    partner; `adoptSuggested` clones a global suggested row into the farm.
  - **Partners UI** (`/partners`): suggested + your-partners sections, add/edit/remove (owner/
    manager; RR admin curates globals), connected badges, provider-free **quick-contact**
    buttons (`src/lib/contact.ts`: SA-aware E.164 → `tel:` / `https://wa.me/<e164>?text=` /
    `mailto:`), a copy-able login-URL card with WhatsApp/email share (WhatsApp Cloud API stays
    deferred). Partners nav item + handshake icon (farm roles + RR admin; not workshop).
  - Demo seed gains a classified TJ workshop + 3 global suggested + 2 farm partners (one
    connected). i18n EN/AF at parity (**784 leaf keys**; `partners.*`/`partnerKind.*`/`contact.*`
    /`nav.partners`). `rls_isolation.sql` F12a section proves global-visible-to-all, farm-owned
    cross-tenant = 0, cross-tenant + operator-role writes denied, anon deny, the scope
    invariant, and that the linked workshop still sees the farm's partners. Gates green
    (typecheck + lint + build + `db:test`); shared first-load JS flat at **102 kB**.
  - **Not built** (later workstreams): work-request flow (F12b), contractor aggregated/
    per-kind dashboards + contractor-plan gating (F12c), checklists (F11).
- **FleetWise F11 — Vehicle checklists & template builder (migrations `0290–0291`;
  branch `claude/fleetwise-checklists`; isolation-tested, `db:test` green):**
  - Mirrors **RapidRiseAi/TJ-autovault**'s inspection template→report pattern
    (`inspection-template-builder` / `inspection-report-form-renderer` /
    `inspection-templates-table` / `lib/inspection-reports` / `*inspection_*` migrations),
    adapted to FleetWise house rules. Field-type model widened per spec §7 to
    **checkbox / text / number / photo / rating / section_break** (TJ's dropdown dropped;
    photo + rating added).
  - **`checklist_templates`** (farm-owned, or GLOBAL/RR-library when `farm_id` null —
    visibility mirrors `service_templates`/`parts_catalogue`) **+ `checklist_template_fields`**
    (ordered; `farm_id` mirrors the parent, composite FK keeps FARM fields isolated; plain
    FK cascades). **`checklist_instances`** (per machine; optional `job_card_id` composite FK
    + nullable `work_request_id` reserved for F12) **+ `checklist_instance_values`** (one row
    per field at fill time — value + note + optional **photo attachment** via a composite FK
    to `attachments(id, farm_id)`; field label/type/order **snapshotted** so a saved
    checklist renders even after the template changes). `attachments.parent_type` extended
    with `checklist_instance`. All farm-scoped RLS + grants + audit + soft-delete;
    `0291` adds the farm-scoped `checklist-photos` bucket (0207-pattern; local no-op).
  - App: **/checklists** template library (global-vs-farm badges, create/edit/duplicate/
    delete) + **builder UI** (`src/components/checklists/template-builder.tsx`:
    add/reorder/type/required/help/section-breaks/rating scale). **Per-vehicle fill flow**
    (`/machines/[id]/checklists/new` → pick template → fill → save; photo fields compressed
    client-side, ferried as base64 through the RLS server action → `src/lib/checklist-media.ts`),
    a read-only **saved-checklist view**, and a machine-detail **"Vehicle checklists" card +
    timeline events**. Roles: owner/manager/mechanic (+RR admin for globals) design
    templates; the broader crew (incl. operator/workshop) fill them. Checklists are ungated
    core (not in the F5 entitlement map). Shared model `src/lib/checklists.ts`; **Checklists**
    nav item + clipboard icon; demo seed gains a global + a farm template and one completed
    inspection. i18n EN/AF at parity (**802 leaf keys**; `checklists.*`/`checklistField.*`/
    `nav.checklists`/`machine.checklists*`). `rls_isolation.sql` F11 section proves
    global-vs-farm template visibility, instance/value farm isolation, cross-tenant +
    composite-FK write denials (fields→other-farm template, value→other-farm photo), and
    anon deny. Gates green (typecheck + lint + build + `db:test`); shared first-load JS flat
    at **102 kB**. Not built (later): contractor work-request link (F12), checklist PDFs.

- **FleetWise F12b — Work-request flow (migrations `0310–0311`; branch
  `claude/fleetwise-work-requests`; isolation-tested, `db:test` green):**
  - **`work_requests`** (farm-initiated jobs to an assigned `workshop`): `kind`
    (repair/quote/inspection/parts/other), full status lifecycle enum
    `requested→viewed→quoted→accepted→in_progress→completed→invoiced→closed`,
    `priority`, `title`/`description`, ex-VAT `quote_amount_cents` +
    `invoice_amount_cents` + `vat_rate_bps`, `job_card_id` link. **`work_request_events`**
    (from/to status + note + by_user) drives the timeline. farm_id + composite FKs
    (machine + job_card), RLS via `app.has_farm_access` (covers farm crew AND the linked
    workshop — the assigned contractor sees/updates exactly the farms they serve), audit,
    soft-delete, grants, anon-zero-DB. `attachments.parent_type` widened to `work_request`.
  - **Invoice → cost, no double-count** (0311, SECURITY DEFINER): setting
    `invoice_amount_cents` UPSERTS a **single** `invoice` `cost_entry` keyed
    `(source_type='work_request', source_id)` → flows into machine TCO; re-edits update in
    place, clearing/deleting soft-deletes it, and a **quote is never costed**. This is the
    ONLY work-request→cost path; converting to a job card books nothing here (the job
    card's own lines cost via the 0211 path), so the two never double-count — asserted in
    `rls_isolation.sql` (F12b section: farm isolation, linked-workshop see+update,
    cross-tenant + anon denial, invoice-once, quote-not-costed, status-change notify).
    A status-change/quote/invoice **notify trigger** fires `app.notify_farm` to
    owner/manager (in-app now; push via F6).
  - App: **/work** list (farm inbox + contractor's assigned view, grouped by status) and
    **/work/[id]** deep-link (vehicle highlighted, lifecycle stepper, events timeline,
    quote/invoice capture + proof upload via the F1 `jobcard-photos`/attachments/service-
    role pattern → `/api/work/media`, contractor quick-contact, **convert-to-job-card**);
    machine-detail **"Get something done"** card (pick a linked contractor + kind →
    pre-filled request) + this-machine request list. Work nav item + icon (all roles incl.
    contractors). Demo seed gains 2 requests (one invoiced → TCO). i18n EN/AF at parity
    (**869 leaf keys**). Gates green (typecheck + lint + build + `db:test`); shared
    first-load JS flat at **102 kB**.
  - **Not built** (F12c): contractor aggregated dashboard / per-kind views + contractor-
    plan gating.

- **FleetWise F12c — Contractor aggregated dashboard & per-kind views (migration
  `0320`; branch `claude/fleetwise-contractor-dashboard`; isolation-tested, `db:test`
  green):**
  - **Aggregated contractor dashboard** (`/contractor`): a `workshop`-role user gets ONE
    dashboard listing **every `work_request` assigned to their workshop across ALL linked
    farms** — the one-account→many-farmers value prop. Farm isolation is RLS's job
    (`app.has_farm_access` already scopes a workshop to its `workshop_links` farms); the
    query **additionally** filters `workshop_id = the user's workshop` so a contractor sees
    only its OWN requests (a farm may use several contractors) and never an unlinked farm's
    data. KPIs (new/in-progress/to-invoice/open), status-grouped list (farm + vehicle +
    kind + quote/invoice + priority + status, priority/updated sort), a **Your clients**
    panel with quick-contact (tel/wa.me/mailto to each farm's owner, reusing F12a
    `src/lib/contact.ts`), and a parts-catalogue shortcut for supply trades. Each row deep-
    links to the existing `/work/[id]` detail (accept/decline, status, notes, quote/invoice/
    proof upload via F12b `/api/work/media`, farmer quick-contact).
  - **Tailored per-kind views** (`src/lib/contractor.ts`): a view-router keyed on
    `workshops.kind` sets each contractor type's DEFAULT focus (mechanic → repair/
    inspection, parts_supplier → parts/quote + catalogue, auto_electrician → electrical,
    panel_beater/tyre/towing → theirs) and tagline — shared components, differing default
    filter/labels. Kind labels reuse F12a's `partnerKind.*`.
  - **Workshop-first shell**: layout routes the logo/home to `/contractor` for the workshop
    role, gives it a contractor-first nav (contractor · work · machines · faults + job
    cards/checklists/alerts) and drops farm-only surfaces; `/dashboard` redirects a
    workshop to `/contractor`; the F12a invite login URL now deep-links to `/contractor`.
  - **Contractor-plan gating seam** (payments DEFERRED): `0320` adds `workshops.plan`
    (`workshop_plan` enum free/pro; additive, default free; RR-admin-writable only, workshop
    reads own via existing 0101 policy). Map = single source of truth
    `src/lib/contractor-plan.ts` (mirrors F5's `entitlements.ts` shape) + `workshopPlan()`
    / `checkWorkshopEntitlement()` in `lib/auth.ts`. NOT a tenancy guard (RLS +
    `workshop_links` stay the sole isolation guarantor → no SQL/RLS mirror needed); gates
    ONE example feature — the **client-analytics** panel (per-client rollups) shows for
    `pro`, an upgrade nudge for `free`. Demo workshop set to `pro`.
  - i18n EN/AF at parity (**973 leaf keys**; `contractor.*`, `contractorPlan.*`,
    `nav.contractor`/`nav.groupContractor`). `rls_isolation.sql` F12c section (fresh Farm E +
    Workshop X) proves aggregation across ≥2 linked farms, own-workshop-only filtering on a
    SHARED farm (RLS lets W see X's row; the workshop_id filter excludes it), unlinked-farm
    invisibility even for a request assigned to the workshop, a cross-tenant write denial,
    and the plan column default. Gates green (typecheck + lint + build + `db:test`); shared
    first-load JS flat at **102 kB** (`/contractor` 105 kB).
  - **Not built** (later): owner inbox (F13, concurrent), multi-site (F7).
- **FleetWise F13 — Owner/manager activity inbox + fleet analytics + reminders
  (migration `0330`; branch `claude/fleetwise-owner-inbox`; isolation-tested,
  `db:test` green):**
  - **Activity inbox** (`/inbox`, owner/manager only): a unified, actionable feed built
    on `work_requests` + `work_request_events` + `notifications` (surfaces the notification
    engine — does NOT duplicate it). Outstanding quote/invoice value stats; a **"Needs your
    action"** list where a quote is **accepted** (`acceptQuote` → status `accepted`) or an
    invoice **approved & closed** (`approveInvoice` → status `closed`) inline (each writes a
    `work_request_event`); **active work grouped by vehicle + contractor** with an unread dot
    (a request with an unread alert) + quick-contact (reuse `src/lib/contact.ts` tel/wa/mail);
    a **recent-activity** feed rendering `formatNotification` with `notificationUrl`
    deep-links + mark-read. Nav item + **unread badge** (new `NavItemData.badge` on
    NavLink/MoreMenu; count via `src/lib/inbox.ts` `countInboxUnread`, RLS-scoped, only for
    owner/manager).
  - **Fleet analytics** (reports section + `contractors.csv`): outstanding quotes/invoices
    (count + value), work-request **throughput by status**, **contractor responsiveness**
    (avg requested→viewed / viewed→quoted from `work_request_events`), **spend via
    contractors** (`cost_entries` type=`invoice`, period-filtered), and a **per-contractor**
    table — all farm-scoped, retired/sold excluded (via `reports/data.ts` `allowed` set).
  - **Reminders** (`0330`, 0205-pattern): `app.enqueue_work_request_reminders` chases
    still-outstanding `quoted`/`invoiced` requests → `quote_awaiting`/`invoice_awaiting`
    to owner/manager, honouring quiet hours; **weekly dedupe read from the notification
    queue itself (no new column)**; retired/sold + non-active farms excluded; SECURITY
    DEFINER, execute revoked from public/anon/authenticated; `public.cron_*` wrapper wired
    into the **nightly cron** route. `formatNotification`/`notificationTitle`/`notificationUrl`
    now render the F12b `work_request_*` templates + the two new reminder templates
    (`pushTitle.work`).
  - **Timelines**: machine-detail history timeline now includes **work requests + their
    quotes/invoices** (new `work` event kind + `WorkIcon`, deep-links to `/work/[id]`).
  - Demo seed: request 1 → `quoted` (R950 ex-VAT) so the inbox "needs action" + quote
    reminder demo; request 2 stays `invoiced`. i18n EN/AF at parity (**973 leaf keys**;
    `inbox.*`, `nav.inbox`, `reports.contractors`/`outstanding*`/`perContractor`/…,
    `notifications.tplWork*`/`tpl*Awaiting`, `pushTitle.work`). `rls_isolation.sql` F13
    section proves engine execute-deny (authenticated/anon), owner+manager-only enqueue,
    cross-tenant isolation, retired-machine exclusion, and the 7-day dedupe. **No new
    table** (reminders reuse the queue); only migration `0330` (engine + cron wrapper).
    Gates green (typecheck + lint + build + `db:test`); shared first-load JS flat at
    **102 kB**. **Not built** (out of scope): contractor dashboard (F12c), multi-site (F7).

- **FleetWise F8 — POPIA, security & backup (migration `0350`; branch
  `claude/fleetwise-popia-security`; isolation-tested, `db:test` green; NFR-2/3/4):**
  - **Docs** (the NFR-2/4 documentation deliverables): `docs/POPIA.md` (personal-data
    inventory across users/auth/usage_logs/faults/attachments/audit_log; lawful bases;
    retention & deletion policy incl. the **AARTO legal-obligation** + **audit-log**
    retention exceptions, documented; cross-border-AI consent+DPA stance per founder
    decision #2; data-subject rights + operational checklist), `docs/SECURITY.md` (RLS as
    the **sole** tenant-isolation guarantor proven by `rls_isolation.sql`; grants/least-
    privilege; encryption in transit/at rest + bcrypt creds — inherited vs configured;
    service-role key server-only handling; zero-anon-DB public-QR property; leaked-
    password toggle + live-project verify list), `docs/BACKUP.md` (Supabase Pro daily
    backups/PITR runbook, PITR + full-project + schema restore procedures, **99.5% uptime
    target** + RPO/RTO, post-restore smoke checks incl. **re-applying erasures after a
    PITR rewind**, quarterly **restore-drill checklist**).
  - **Data-subject rights RPCs** (`0350`, SECURITY DEFINER, `search_path` pinned):
    `public.export_personal_data(uuid)` (DSAR → full JSON bundle: profile + usage_logs +
    meter_readings + faults + job_cards + cost_entries + attachments + notifications +
    audit actions) and `public.erase_personal_data(uuid,text)` (**anonymise, not hard-
    delete** — clears name/email/phone, deactivates + soft-deletes, nulls free-text name
    copies in usage_logs/faults; keeps de-identified structural + legally-retained AARTO
    history). Shared guard `app.assert_can_manage_person` (revoked from
    public/anon/authenticated) = owner/manager-of-the-subject's-farm **or** rr_admin
    (cross-tenant, **logged** via `data_subject_export`/`_erasure` audit rows); execute
    **revoked from anon**, granted to authenticated (self-guarded); self-erase blocked.
    The `users` audit trigger records the erasure diff (proof); audit_log retained by
    documented choice.
  - App: **Team → per-person Export data** (`GET /team/export?user=` route → downloadable
    JSON, RPC-guarded → 403 for non-owner/manager) + **Erase personal data** (`erasePerson`
    server action → RPC, then service-role auth-scrub of the residual `auth.users` email +
    ban re-login; belt-and-braces, soft-fails without Auth admin). New reusable
    `ConfirmForm` client component (native confirm before destructive submit); **Data &
    privacy (POPIA)** info card on Team. Fixed the last visible `FarmGear`→`FleetWise`
    onboarding string in en/af. i18n EN/AF at parity (**1019 leaf keys**; `privacy.*`).
    `rls_isolation.sql` F8 section proves anon execute-deny on both RPCs (+ guard revoked
    from authenticated), farm-scoping (cross-farm export/erase raises), rr_admin cross-
    tenant export + logging, post-erase anonymisation (name/email/phone/active/soft-delete
    + name-copy scrub), and self-erase block. Gates green (typecheck + lint + build +
    `db:test`); shared first-load JS flat at **102 kB** (`/team` 105 kB). **Not built**
    (out of scope): multi-site (F7), observability/Sentry (NFR-6).
- **FleetWise F7 — Multi-site + per-role visibility (migrations `0340–0341`; branch
  `claude/fleetwise-multisite`; isolation-tested, `db:test` green — the MOST tenancy-
  sensitive change; every prior isolation assertion kept green, model extended not weakened):**
  - **Multi-site (FR-1.5)**: new **`user_farm_memberships`** spine (`user_id`,`farm_id`,
    `role`,active,soft-delete; role-check excludes rr_admin/workshop; unique per user+farm;
    RLS + audit + grants + anon-zero). `app.accessible_farm_ids()`/`app.has_farm_access()`
    rewritten to **UNION active memberships** ON TOP of the primary-farm + workshop-link
    paths — **purely additive** (`users.farm_id` stays the default/primary; idempotent
    backfill of a membership per current farm user makes the new union == old behaviour, so
    the isolation suite's directly-seeded users still resolve via the primary path). The
    workshop path (`workshop_links`) is untouched. Membership `active=false` immediately
    removes access (dynamic scoping, like `workshop_links`).
  - **Per-role visibility (FR-2.3/FR-8.1), enforced in RLS not just UI** — helpers
    `app.row_visible_to_role(farm,machine)` + `app.work_request_visible(wr)` (SEC DEFINER,
    search_path pinned, execute revoked from public/anon). **Operators** see only machines
    where `assigned_operator_id = auth.uid()` and only those machines' child rows
    (`machines`,`meter_readings`,`service_plan_lines`,`faults`,`job_cards`,`watch_items`,
    `fuel_issues`,`usage_logs`,`licences`,`work_requests`); owner/manager/mechanic keep full
    farm access (the predicate reduces to `has_farm_access` for every non-operator, so no
    seeded persona's counts change). **Contractors (workshop)** now see **and may update**
    only work_requests assigned to their own workshop (+ their events + `work_request`
    attachments) — closing the F12c gap where the workshop_id filter was app-only. Farm crew
    keep full access.
  - **App layer**: `accessibleFarms()`/`currentFarmId()` + `CURRENT_FARM_COOKIE` in
    `lib/auth.ts` (validated cookie choice, default primary; null for rr_admin/workshop);
    `setCurrentFarm` server action; **`SiteSwitcher`** in the shell (desktop sidebar + mobile
    bar) shown only when the account reaches >1 farm; **dashboard + machines list + reports
    (page & all 6 CSV routes) scope every farm-keyed query to the current farm** (completes
    FR-11.3; single-farm users unaffected — RLS already scopes them). Team/settings stay on
    the primary farm (documented boundary).
  - `rls_isolation.sql` **F7 section** (fresh Farms F/G/H): multi-site union sees exactly
    F∪G never H, membership revoke removes G while primary F holds, membership table
    own-user/farm-admin isolation + anon-deny + non-admin cannot self-grant; operator sees
    only the assigned machine + its child/work rows and is denied a non-assigned one; two
    contractors on a **shared** farm each see/mutate ONLY their own request. **Reconciled
    F12c** (the one place an assertion encoded the now-fixed leak): W no longer sees X's
    request on a shared farm — RLS enforces workshop-scoping. i18n EN/AF at parity
    (**1012 leaf keys**; `nav.switchFarm`). Gates green (typecheck + lint + build +
    `db:test`); shared first-load JS flat at **102 kB**. Migrations **0340–0341** only.

- **FleetWise G1 — Budgets & utilisation analytics (migrations `0360–0361`; branch
  `claude/fleetwise-budgets-analytics`; isolation-tested, `db:test` green; FR-10.4/10.5,
  §23):**
  - **Budgets + budget-vs-actual (FR-10.4)**: new **`budgets`** table (`0360`) — a spend
    target (ex-VAT cents) for a period, optionally narrowed to one machine and/or one cost
    category (both nullable, like `cost_entries.machine_id`). `period_type`
    (month/quarter/year) + explicit `period_start`/`period_end`; farm-scoped RLS
    (`has_farm_access`) + composite FK + audit + soft-delete + grants; a `NULLS NOT
    DISTINCT` unique index dedupes each scope+period. **Actual is never stored** — summed
    live from the F1 `cost_entries` ledger over the budget's own scope+period (shared
    `src/lib/budgets.ts`, so machine-detail + reports agree), with over/near/under
    indicators. UI: machine-detail **Budgets card** (owner/manager CRUD via
    `budget-actions.ts`) + reports **Budget-vs-actual** table + `budgets.csv`.
  - **Utilisation (§23)** — hours/km **used vs idle** over a window, in `src/lib/analytics.ts`
    (documented): `used = last meter reading on/before `to` − baseline (last reading
    on/before `from`, else first in-window)`; `available = window-days × capacity/day`
    (farm settings `utilisation_hours_per_day`/`_km_per_day`, defaults 10 h / 200 km);
    `pct = used ÷ available`; `idle = available − used`. Machine detail shows a trailing
    90-day card; reports a per-machine column (window = report period, or trailing 90 d for
    "all time").
  - **Downtime per asset (§23)** — days a machine was **in_workshop/out_of_service**,
    reconstructed in SQL (`0361 app.fleet_downtime`/`app.machine_downtime_days`, SECURITY
    INVOKER so audit_log RLS scopes it) from the **audit_log status trail** (INSERT status +
    every status-changing UPDATE, each status held until the next event or now(), clipped to
    the window; `public.*` PostgREST wrappers, execute revoked from anon). Shown on machine
    detail + reports (utilisation table).
  - **Repair-vs-replace (FR-10.5)**: `repairVsReplace()` flags "consider replacing" once
    lifetime **repair spend (parts+labour+other+invoice) ÷ purchase price** ≥ a farm-
    settings threshold (`repair_replace_pct`, default 60%) — badge + ratio on machine-detail
    lifetime stats.
  - Settings gains an **Analytics & budgets** card (repair-replace % + utilisation
    capacity). Demo seed gains 3 budgets (one over) + a 12-day New Holland downtime trail.
    i18n EN/AF at parity (**1071 leaf keys**; `budget.*`/`budgetPeriod.*`/`util.*` +
    `machine.*`/`settings.*` additions). `rls_isolation.sql` G1 section proves `budgets`
    farm isolation + cross-tenant/anon write denial, and downtime reconstruction + its
    farm-scoping (Owner B sees 0 for a Farm A machine) + anon execute-deny. Gates green
    (typecheck + lint + build + `db:test`); shared first-load JS flat at **102 kB**.
    Migrations **0360–0361** only.

- **UI/UX redesign — Phase 0: the six code defects** (branch `claude/fleetwise-ui-redesign-l4ng55`;
  no migration, no backend behaviour change; gates green):
  - Design handoff committed at `design_handoff_fleetwise_ui_upgrade/` (22-screen redesign +
    176-finding audit + build order + tokens). Phases 1–3 (shared components, then the five
    daily-loop screens, then the rest) are **not** started.
  - **Bug 1** onboarding step 3 ("put QR stickers on") shared step 1's `machines > 0` and ticked
    itself. It now has its own condition — an explicit acknowledgement stored as
    `farms.settings.qr_labels_printed_at` through the **existing** owner/manager-guarded
    `update_farm_settings` RPC (0204, jsonb `||` merge), so no schema/RLS change; undoable.
  - **Bug 2** every pre-auth `t()` ran with no locale (login, public QR), so a bilingual product
    opened in English for every Afrikaans farm. New `src/lib/locale.ts` `deviceLocale()`
    (cookie `fw_lang` → `Accept-Language` → `en`), `setDeviceLanguage` action + visible
    `DeviceLanguageSwitcher` on login and `/m/[token]`, `<html lang>` now follows it, and the
    signed-in `setLanguage` mirrors the profile choice into the same cookie. The QR route reads
    a cookie and a header only — **zero-anon-DB unchanged**.
  - **Bug 3** `impersonateFarm` writes an audit row and nothing else — no farm context, no
    session change. Copy now matches behaviour ("Record support access"; the flash says you are
    still Rapid Rise). **Real support mode (farm-context cookie + `exit` log) awaits sign-off.**
  - **Bug 4** `acceptQuote`/`approveInvoice` committed real money from a `size="sm"` submit. Now
    behind the new **`ConfirmDialog`**, naming the amount and comparing quote to bill. Both
    server actions, their `id` field and their redirects are untouched.
  - **Bug 5** POPIA `erasePerson` was a ghost link behind `window.confirm()` → a dialog stating
    what is lost, pointing at the reversible option, **type-the-name to unlock**. There is no
    machine-delete action in this codebase (audit inaccuracy); the five real one-click deletes on
    machine detail (service line, kit, kit item, licence, budget) got the same treatment, the
    icon-only `✕` included. Seven other no-confirm deletes (fines/parts/partners/templates/
    checklists/job-card lines) are deferred to Phase 1.
  - **Bug 6** the CSV header failure rendered `name_required — previewTitle` ("Name is required —
    Preview"). `validateCsv` now returns `headerFound`, and empty-file vs missing-name-column get
    their own messages naming the columns actually present.
  - New shared UI: `ConfirmDialog` (bottom sheet on phones, centred modal from `sm`; optional
    type-to-confirm; 48px targets; icon **and** word) on a new `align="responsive"` in
    `dialog.tsx`, plus `TrashIcon`. i18n EN/AF at parity (**1203 leaf keys**). Shared first-load
    JS flat at **102 kB**.

- **UI/UX redesign — Phases 1–3** (branch `claude/fleetwise-ui-redesign-l4ng55`; no
  migration, no backend behaviour change; gates green; shared first-load JS flat at **102 kB**):
  - **Phase 1 — shared components** (where ~60% of the audit lives). `badge.tsx` gains an
    eight-glyph **shape vocabulary** + per-enum maps so status is always **shape + word +
    colour**; new `components/ui/status.tsx` exposes one badge per domain enum (machine,
    job, fault, urgency, work, priority, expiry, budget, fine, service) — 19 call sites
    converted, 3 local `statusTone` helpers deleted. New **`lib/format.ts`** (thousands
    separators, unit words, relative dates, role labels, `vatPercent`/`percentToBps`).
    `empty-state.tsx` splits into **`AllClear` / `GetStarted` / `NoMatches`**. `field.tsx`
    gains **`TextField`/`SelectField`/`TextareaField`**. New **`FilterChips`/`ActiveFilters`**
    (same URL params). Buttons step **down** at `sm` (48px mobile → 40–44px desktop).
    All 12 destructive actions now go through `ConfirmDialog`.
  - **Phase 2 — the daily loop.** **Farm home**: seven counters → one ranked "Needs your
    attention" list, worst first, each row deep-linked to the thing it names + greeting/farm/
    date header + `AllClear`. **Machines list**: six statuses no longer all grey, `184 320 km`
    + "read 3 days ago", chips replace the submit-to-filter card, "Set up a plan" replaces an
    invisible dash, first-run vs no-match empty states, 132px mobile photo. **Job card**: three
    plain questions, visible status pipeline, running total above the lines, blocker stated
    before you try, VAT in words, silent draft recovery, primary/secondary inversion fixed.
    **Owner inbox**: one card per decision, quote vs bill visibly different, a visible "no"
    path. **QR/driver**: one question + four tiles (was four open forms), every field
    labelled, leads with the machine photo, icons not emoji. **Faults**: urgency-ordered,
    one primary action, 132px photo, celebratory empty state.
  - **Phase 3 — the rest.** **Shell**: 3 sidebar groups + "Everything else", permanent green
    Report tab. **Machine detail**: 20 cards → **5 tabs** + a header that answers "what is
    this and what do I do". **New `/driver` home** for the operator role (4 tiles, photo
    machine grid, closes the loop on their reports, sign-out in reach) + operator shell.
    Cross-cutting sweeps: ISO/`en-ZA` dates → words, `Rr_admin` → role labels, VAT asked in
    **percent** (`VatRateField`, still posts `vat_rate_bps`), placeholder-as-label cleared
    from the parts editor and contractor money fields, chips on jobcards/work, `AllClear`
    empty states, login gains the **"no work email? use the QR stickers"** path and
    translates Supabase's raw error strings, diesel loses its bookkeeping vocabulary,
    settings' 8 cards become jump-to groups with a sticky save, contact buttons get words.
  - **Defect found while rebuilding** (not in the audit): the job-card list's "New" form
    never posted `farm_id`, which `createJobCard` requires — the button failed with
    "Missing machine" and created nothing. Fixed; the form now also lets you pick the job
    **type** instead of hardcoding `repair`. `JOB_TYPES`/`JOB_STATUSES`/`LINE_KINDS` moved to
    `lib/job-options.ts` (a `"use server"` file may only export async functions).
  - i18n EN/AF at parity (**1489 leaf keys**).
  - **Still awaiting sign-off** (both flagged in the handoff as behavioural): real
    impersonation state (farm-context cookie + `exit` log) — Phase 0 left the copy honest;
    and the operator landing (`requireRole` → `/dashboard?error=forbidden`, never rendered).
    Deferred by request to the later backend/security pass: `/partners` rendering a
    contractor login URL as copyable plain text, and CSV **column mapping** on import.

- **Backend & security pass** (branch `claude/fleetwise-ui-redesign-l4ng55`, restarted from
  the merged `main`; **no migration**; gates green; shared first-load JS flat at **102 kB**):
  - **Contractor login link was a credential in a query string.** `inviteContractor` /
    `sendLoginUrl` redirected to `/partners?…&loginUrl=<action_link>`. A Supabase
    `action_link` is a BEARER credential — whoever holds it signs in as that contractor
    and reaches every farm they are linked to — and a query string lands in browser
    history, access logs, the `Referer` header and the address bar. Now a short-lived
    **httpOnly, SameSite=Strict cookie** scoped to `/partners` (`src/lib/partner-link.ts`,
    10-min TTL), read once by the server render, cleared by an explicit "done with it"
    action. The card says plainly that the link signs someone in, names who, and when it
    dies.
  - **Open redirect on `/auth/callback`**: `next` was concatenated onto the origin
    unchecked (`//evil.com`, `/\evil.com`). New **`src/lib/safe-path.ts`** `safePath()` —
    single leading slash, no scheme-relative form, re-checked after decoding — used by the
    callback AND by the three `back` form fields in `team/actions.ts` that were also
    unvalidated redirect targets. 12 cases proved incl. `%2f%2f` / `%5C%5C` bypasses.
  - **S11 operator landing (was awaiting sign-off).** `requireRole` sent EVERY denied user
    to `/dashboard?error=forbidden` — for an operator, the owner's money page — and
    `forbidden` was never rendered. New **`homePathFor(role)`** is the single source of
    truth; `requireRole` bounces to the role's own home with `?denied=1`, rendered as a
    sentence on `/driver`. New **`/home`** dispatcher for post-login + magic link (a link
    minted pre-sign-in cannot know its role). Settings/onboarding bounces follow suit.
  - **S10 support mode (was awaiting sign-off).** Entering now pins the farm in an
    httpOnly cookie that `currentFarmId` honours for rr_admin (`SUPPORT_FARM_COOKIE`,
    `supportFarmId`/`supportFarm`), so every farm-scoped surface narrows to that customer;
    a **`SupportBanner`** names the farm on every screen and exits in one tap; leaving
    writes the paired **`exit`** audit row via the existing RPC, so the log shows duration.
    A NARROWING not a grant — rr_admin already reads all farms via `app.is_rr_admin()`, so
    a forged cookie cannot widen access (and the id is validated against a real farm).
    `rls_isolation.sql` §0206 gains 3 assertions (non-admin exit denied, enter+exit pair,
    exit row farm-scoped).
  - **CSV column mapping (S21).** Headers were matched against a fixed set, so an
    Afrikaans/reordered farm sheet failed wholesale. `csv.ts` gains `guessMapping` (alias
    table, Afrikaans first-class), `applyMapping`, `readHeaders`, `countDataRows`;
    the import client shows the guessed match + a sample value and lets the user correct
    it. **Mapping happens in the browser and the CANONICAL sheet is posted**, so
    `validateCsv`/`importMachines` are untouched. Verified on a full Afrikaans sheet with a
    junk column and a reordered English one.
  - **Runtime verification** (the gap flagged at merge): production build booted and driven
    with Chromium. All 24 routes guard correctly signed-out; public QR handles an unknown
    token; no uncaught page errors; no horizontal overflow at 1440px or on a phone;
    `Accept-Language: af-ZA` renders login fully in Afrikaans and the AF button writes
    `fw_lang`. **Three defects the browser found that reading the code did not:** the login
    fields were still placeholder-only (3 → 0 unlabelled); the language buttons announced
    "Afrikaans" while showing "AF" (WCAG 2.5.3 Label in Name); and `?error=no-profile` —
    what the guards append when nobody is signed in — rendered as "That didn't work."
  - i18n EN/AF at parity (**1512 leaf keys**). Smoke test kept at
    `scratchpad` (not committed); re-runnable with a placeholder `.env.local`.
  - **Live click-through against the hosted demo project** (`nmqtcvdwtyggxjjgtnzm`; the
    last remaining gap — every earlier run used placeholder env, so no query, no RLS
    decision and no role dispatch had ever actually executed). Demo logins are in
    `docs/FLEETWISE_MANUAL_SETUP_GUIDE.md` (password `FleetWise!demo1`). Signed in as
    owner / operator / contractor / rr_admin and drove the built app:
    - **Role dispatch** — `/home` forwards owner→`/dashboard`, operator→`/driver`,
      workshop→`/contractor`, rr_admin→`/admin/farms`. An operator opening `/settings`
      lands on `/driver?denied=1` and reads a sentence, not the owner's money page (S11).
    - **Support mode (S10) end to end** — entering narrows the machine list from **15
      (all farms) to 3** (Rooikoppies), the banner names the customer and follows across
      screens, exit clears it, and `audit_log` holds a farm-scoped `impersonate`/`exit`
      **pair** seconds apart, so the log shows duration. A garbage `fw_support_farm`
      cookie falls back to the un-narrowed rr_admin view — it is a narrowing, not a grant.
    - **CSV mapping (S21)** on a real Afrikaans sheet (reordered, one junk column):
      6/6 canonical columns guessed, junk left unmapped. Stopped before writing.
    - Dashboard ranked-attention rows deep-link to the machines they name (10 of them);
      5 distinct status tones on the machines list; machine detail exactly 5 tabs.
    - **One defect the live run found that reading the code did not:** the mobile machine
      card nested an `<a>` ("Set up a plan") inside the card's own `<a>`. Invalid HTML →
      the browser un-nests it → hydration mismatch (React #418) → the list was thrown away
      and re-rendered client-side on every load. Fixed; the prompt is a span inside the
      card, still a link in the desktop table. A sweep of **30 route loads across 4 roles,
      desktop and phone**, is now clean of nesting warnings, hydration failures, uncaught
      errors and horizontal overflow.
    - Nothing was written to demo data beyond the two support-mode audit rows; `.env.local`
      was removed afterwards.

> Update this "current status" block at the end of every session.
