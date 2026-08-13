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

- **Accessibility pass — the 48px floor and icon+word, measured not asserted** (same
  branch; no migration; gates green; shared first-load JS flat at **102 kB**):
  - **How it was found.** A Playwright pass measured the *rendered* height of every
    `button`/`select`/`[role=tab]` on a Pixel 5 across all four roles (25 route loads).
    Grepping Tailwind classes had said the floor held; measuring said **155 controls were
    under 48px**. The floor lived in `button.tsx` alone — every other primitive was still
    44px, so the rule was true of buttons and false of everything beside them.
  - **Raised at the source**, each stepping down only at `sm:` (where there is a mouse):
    `input.tsx` `controlBase` (→ Input/Select/Textarea, the biggest single win),
    `filter-chips`, `nav`, `tabs`, `device-language-switcher`, `site-switcher`,
    `print-button`, `fault-capture`, the `/reports` period + site controls. `Button`'s
    `sm` no longer steps down on a phone at all (48px), only on desktop.
  - **Emoji were standing in for icons** in 5 files (`📷 🎤 ⏹ 📍 🔒 ☑ ✓`) — they render
    differently per Android skin, ignore `currentColor`, and read aloud as their unicode
    name. Added **CameraIcon/MicIcon/StopIcon/PinIcon/LockIcon/SquareIcon** at the set's
    1.75 line weight and replaced every one.
  - **Icon-only controls eliminated**: dialog close, toast dismiss and the alerts bell all
    carry their word now. The **offline pill** showed its label only from `sm:` up — on a
    phone "are we offline?" was answered by a coloured dot alone.
  - **S22 (checklist template builder) had never been through the redesign** — raw markup,
    ~26px buttons, no icons, every input labelled only by its placeholder. Rebuilt on the
    kit (Field/Input/Select/Button/Flash), real labels, icons + words, sticky save.
  - Also fixed: inbox still rendered one date as `en-ZA` digits; the faults page had an
    `eslint-disable` one line above the element it was meant to cover (the repo's only
    lint warning); `machineType.implement` was the last untranslated AF string (→
    "Werktuig"). i18n EN/AF at parity (**1512 leaf keys**).
  - **Re-measured, not re-read: 0 controls under 48px, 0 icon-only.** Hydration/nesting/
    overflow sweep clean; the three live suites (role dispatch + support-mode narrowing +
    Afrikaans CSV mapping) still pass; `db:test` green.

- **Language fix, tone, page help, filters, loading, install & walkthrough**
  (migration `0370`; branch `claude/fleetwise-ui-redesign-l4ng55`; gates green; shared
  first-load JS flat at **102 kB**; i18n EN/AF at parity **1,648 leaf keys**):
  - **The language bug, reproduced then fixed.** Choosing Afrikaans on the login screen
    and signing in gave you an English app: `users.language` is `not null default 'en'`,
    so "I chose English" and "nobody ever asked me" were the same value and the untouched
    default outranked the only real choice. `<html lang>` meanwhile read the cookie, so
    the page announced Afrikaans while rendering English. `0370` adds `language_set_at`;
    `syncLocaleOnSignIn` (`src/lib/locale-sync.ts`) reconciles at the only two places a
    session begins — the password action and the magic-link callback, both of which may
    set cookies, which a Server Component may not. A deliberate choice always wins and
    corrects the cookie; an unconfigured profile adopts the device choice and stamps it,
    which is what stops a shared farm-office PC re-languaging the next person.
  - **Tone (friendly vs professional)**, per person, independent of language. An OVERLAY
    (`en.professional.json`/`af.professional.json`, 141 keys each) over the one dictionary
    — no third and fourth translation to keep at parity, and a professional-tone user
    cannot hit an untranslated string. `Lang` widens `Locale` (`"en"|"af"|"en-pro"|"af-pro"`)
    so **`t(key, locale)` is unchanged at every call site**; pages read the composed
    `profile.lang`, the EN/AF control reads `profile.language`. `format.ts` compares
    `localeOf(locale)` — otherwise an af-pro user's dates format in English.
  - **"What is this?" on every page** (`PageInfo`/`PageInfoButton`, `pageInfo.*`): what the
    screen is for, what you can do, and a note where it matters. Also the tour's re-entry.
  - **Filters**: the machines list stacked 4 unlabelled chip rows (~200px before the first
    machine, group names only in `aria-label`). New `FilterBar` — one control with a count,
    named removable pills, groups behind a disclosure with visible headings; same URL
    params. Applied to machines/jobcards/work. Chips are `<Link>`s now, which navigate
    before hydration and prefetch. (They replaced a `router.push` version observed not
    navigating; the cause was never established — `router.push` works everywhere else,
    including same-route query changes on a segment with a `loading.tsx` — so treat it as
    unexplained, not a known Next defect.) Dead `filter-chips.tsx` removed.
  - **Loading**: only 3 of 31 route segments had a `loading.tsx`; all do now, from a shared
    `PageSkeleton`. Plus a top `RouteProgress` bar (links + server-action submits) and the
    app's first `error.tsx`.
  - **/install**: the PWA install path, honest that there is no file — real button via
    `beforeinstallprompt`, spelled-out iOS steps, already-installed state; says what works
    with no signal. Reachable from nav for every role.
  - **Walkthrough** (`src/lib/tour.ts` + `src/components/tour.tsx`): cards, not DOM
    spotlights — each ends in a link to the real screen, progress saved per step in
    localStorage so leaving resumes. Role-aware (owner 8 / driver 6 / contractor 5 /
    mechanic 6). Auto-opens on the role's home only; Skip on card one; re-openable from
    any page's info panel.
  - Verified live against the demo project on a phone viewport: pre-login language choice
    survives sign-in with `<html lang>` agreeing; a switch changes all 7 pages walked;
    af+professional resolve together; 15 pages carry the info button; no chip rows on
    first paint and filtering writes `type=tractor` as before; the tour opens/advances/
    resumes/stays-skipped/restarts and drivers get driver copy. Hydration, tap-target
    (0 under 48px, 0 icon-only), role-dispatch, support-mode suites all still pass.

- **FleetWise F14 — Partner commercial suite: branded quotes, invoices & payments**
  (migrations `0380–0384`; branch `claude/fleetwise-ui-redesign-l4ng55`; isolation-tested,
  `db:test` green; verified live against the demo project):
  - Brings **TJ-AutoVault's commercial layer** onto the FleetWise spine, reshaped for how
    this product is sold. AutoVault's tenant is a workshop and its customers get their own
    login; ours is a farm, and partners reach in through `workshop_links` + RLS. So the
    documents live on the farm's side of the fence and are scoped to the issuing partner.
  - **`0380` partner business profile** on `workshops` (not a parallel branding table —
    a workshop already IS the partner account, so RLS/audit/grants come along): trading
    name, company reg, VAT number, address, banking, logo, two brand colours, standing
    terms + footer, numbering prefixes and per-partner counters.
    `app.next_document_number` allocates under a row lock (two staff issuing at the same
    second get 0007 and 0008); the `public.` wrapper refuses another partner's sequence.
    New `workshops_upd_self` policy lets a partner maintain its OWN letterhead, and a
    guard trigger rejects a plan change from anyone but RR — no self-upgrade.
  - **`0381` `partner_documents` + `_lines` + `partner_payments`.** ONE table with a
    `kind`, not AutoVault's separate quote/invoice pairs (which it then spent five
    migrations dragging back into step) — converting a quote to an invoice is a copy, not
    a translation between schemas. Money ex-VAT integer cents; **lines roll up by
    trigger, payments roll up by trigger, status follows** — no total is ever typed.
    `source='uploaded'` is the load-bearing case: a partner on Sage/Xero/a receipt book
    attaches the finished PDF and types the total, so **they are never dependent on our
    invoicing**. **Invoice → ledger exactly once**: an issued partner invoice OWNS the
    cost for its work request and `0311` is replaced to stand down; a quote is never
    costed. Visibility (`app.partner_doc_visible`): a partner sees only what IT issued on
    farms it is linked to — **two contractors on one farm never see each other's
    pricing** — and operators see none at all.
  - **`0382` plans reshaped free/pro → portal/managed**, because partners choose between
    two different products, not two rungs. *Portal*: their customers see the fleet with
    them in it, their letterhead, their own uploaded paperwork. *Managed*: building
    quotes/invoices here, payments, cross-client analytics. Uploading stays core on every
    plan. Payments still deferred. Two Storage buckets (workshop-scoped branding,
    farm-scoped documents).
  - **`0383` a partner's DRAFT is private** — found by driving the built app: an unsent
    draft was showing in the farmer's list while the partner was still pricing it.
  - **`0384` the number allocator skips numbers already in use** — found the same way:
    pressing "Start it" failed with a raw Postgres unique-violation and created nothing
    once the counter and the rows had drifted (as they do after a restore or an import).
  - App: **/documents** (one route, two audiences — partner sees what it issued across
    every farm; farmer sees what was sent, decision-first), **/documents/[id]** (the
    document renders identically for both sides; the actions beneath differ),
    **/contractor/settings** (business profile, letterhead previewed as a document above
    the fields that change it), **/admin/partners** (RR sets the product; indicative price
    shown, display only). The **PDF engine is brandable** — partner wordmark, logo, colour,
    footer — with the letterhead **frozen onto the document at send time**, so a rebrand
    next year cannot restate last year's invoice.
  - i18n EN/AF at parity (**1,847 leaf keys**) plus professional-tone overlays for the new
    surfaces. Demo seed gains TJ's full letterhead and three documents (sent quote,
    part-paid invoice, draft). Gates green; shared first-load JS flat at **102 kB**.
  - **Verified live** against the hosted demo project as four roles: partner sees its own
    3 documents and not the other partner's on a shared farm; owner sees all 4 raised
    against the farm and not the unsent draft; other farm's owner and the operator see 0;
    letterhead renders in the partner's own red; branded PDF generates; a Portal partner
    is refused the builder but keeps the upload path. Write path driven end to end:
    build → VAT-inclusive price stored ex-VAT → send → farmer accepts.

- **THE FREEZE: `useSearchParams` in the root layout** (same branch; no migration):
  - Chasing why a newly-added document line never appeared, the browser showed the router
    fetching the redirect's RSC payload (200, ~52 KB, under a second) and then **never
    committing the transition** — the screen sat on its loading skeleton indefinitely,
    still stuck at 40 seconds. Measured **9 stuck out of 10**.
  - It reproduced just as hard on the **pre-existing** work-request page, so this was not
    new: **every server action in the product** — every save, every status change, every
    note — could leave someone staring at a frozen screen. It is almost certainly the same
    fault as the earlier, never-established report of a same-route `router.push` that
    appeared not to navigate.
  - Cause: `RouteProgress` (root layout) called `useSearchParams()` to notice a query-only
    navigation. Server actions redirect to the same path with a new query (`?saved=1`,
    `?added=1`, `?error=…`) — exactly the case that subscription governs. The layout
    ALREADY wrapped it in `<Suspense>`, the documented remedy, and it froze anyway
    (re-measured: still 1 in 4). Ruled out by measurement first: the service worker
    (A/B, no change), `loading.tsx` (removed, no change), and the server itself (RSC
    payloads fetched directly — complete and fast).
  - Fix: drop the subscription. Completion now comes from `usePathname()` plus an 8-second
    hard stop. A query-only navigation rides the hard stop rather than finishing on
    arrival — deliberate: the obvious improvement (sampling `window.location.href` from
    the tick) was built and measured and **brought the freeze straight back, 4 of 4**,
    because setting state in a root-layout component while the transition is committing is
    the same class of mistake. **0 stuck in 12** afterwards, on new and pre-existing pages
    alike.

- **FleetWise F15 — Offline that tells the truth, a sidebar that hides nothing, and the
  partner's own client book** (migrations `0390–0391`; isolation-tested, `db:test` green;
  verified live against the demo project):
  - **Offline was lying.** `sw.js`'s `APP_FALLBACKS` applied to EVERY uncached navigation,
    so tapping Reports with no signal silently rendered the DASHBOARD while the address
    bar still said `/reports` — someone reads the dashboard's numbers believing they are
    looking at reports. Fallbacks now apply only to a cold LAUNCH (`/`, `/home`), which
    are dispatchers with no screen of their own; anything else uncached says so.
    Additionally the app now **pre-warms the routes this ROLE can reach**
    (`WarmRoutes` → `sw.js` `warm` message), so a driver warms the driver's screens and an
    owner theirs, instead of "whatever you happened to visit". Cache version → `v3`.
    Measured live: 12+ pages cached without visiting them; machines/faults/jobcards each
    render themselves offline; an uncached page shows the offline notice, not the dashboard.
  - **Sidebar**: the "Everything else" `<details>` hid parts, partners, checklists, fines,
    settings, admin and install behind a summary — invisible to anyone who never found it.
    Now a named group like any other, inside a new **`ScrollArea`**: measured edge fades
    (only when there is genuinely more), a visible thin scrollbar rather than the overlay
    one, and a keyboard-reachable `role="region"`. **17 nav items on screen for an owner,
    0 disclosures.**
  - **`0390` partner client book** — the first tables scoped to a WORKSHOP rather than a
    farm. `partner_clients` (the partner's own customer record) + `partner_client_vehicles`
    (a mechanic's notebook: make/model/reg, free text, before the customer is on FleetWise).
    **A client row carries no authority**: setting `farm_id` on one does NOT grant access —
    that still comes solely from an ACTIVE `workshop_link`, and `app.has_farm_access` is
    untouched. Proven: the F15 suite writes a Farm B id onto a client row as a partner with
    no link and asserts it still sees 0 of that farm's machines.
  - **The handshake, both directions.** `workshop_link_status` already had `pending` and
    `has_farm_access` counts only `active`, so a request needed no new table: 0390 adds one
    narrow policy letting a partner raise a **pending** link for its own workshop, and
    approval stays with the farm's owner/manager (`wl_upd` never covered workshops). A
    partner therefore cannot connect itself to anybody, cannot raise an ACTIVE link, and
    cannot raise one on another workshop's behalf — all asserted. The farm decides on
    `/partners` behind a confirmation that states exactly what access is granted.
  - **`0391`** — found by driving it: the request rendered as an empty row with no name,
    because `workshops_sel` (0101) let a farm read a workshop only through an ACTIVE link.
    You cannot approve a contractor you are not allowed to see. Widened to `pending`, which
    discloses the business card they are holding out, to the one farm they asked, and
    nothing else.
  - **Sync**: once linked, `syncClientVehicles` copies the notebook vehicles into the farm's
    real fleet through the RLS client (so it works because the link is active, and stops the
    moment it is revoked), records the `machine_id` each became, and `synced_at` closes the
    offer so a fleet cannot be duplicated by a second press.
  - The connect request **never tells a partner whether an address has a FleetWise account**
    — the action resolves it with the service role and says the same thing either way.
  - New `/contractor/clients` (+ detail) and a Clients nav item; contractor nav gains
    machines back. i18n EN/AF at parity (**1,937 leaf keys**) with professional-tone
    overlays. Demo seed gains three clients (linked / asked / not on FleetWise) with
    notebook vehicles, and a live pending request to the second farm. Gates green; shared
    first-load JS flat at **102 kB**.
  - **`0392` + app fixes, from automated review of the PR — all seven findings were real:**
    (1) **a contractor could read its competitors' business cards.** The `workshops_sel`
    link clause is guarded by `app.has_farm_access`, which deliberately admits a WORKSHOP
    with an active link — so any contractor on a shared farm could read every other
    contractor's name, trade, phone and email. NOT new in 0391: the pre-existing `active`
    clause had the same hole. Both closed by gating the clause on a new `app.is_farm_side()`.
    (2) **an approval bound the wrong client, or none** — it matched every unbound
    `requested` row for the workshop and set them all to the approving farm, colliding on
    `(workshop_id, farm_id)` and aborting *after* the link had gone active, with the error
    swallowed. New `partner_clients.requested_farm_id` records what each request was aimed
    at. (3) **multi-site**: the request list showed pending links for every accessible farm
    while approve wrote to `profile.farm_id` — now scoped to `currentFarmId` and the farm
    carried through the action, re-validated against `accessibleFarms()`. (4) **`synced_at`
    was set even when copies failed**, permanently hiding the retry; now only on a clean
    run, with a partial result reported as a warning. (5) **`ignoreDuplicates` hid an
    existing link** so a revoked relationship could never be reopened; the existing row is
    now read and handled by status. (6) **"add to my book"** on an already-connected farm
    created an *unlinked* record; it now carries the farm id, verified against a live active
    link. (7) **the offline cache was not partitioned by account** — Cache Storage is
    origin-wide and keyed by URL alone, so on a shared farm-office browser one person's
    cached screens could be served offline to the next; `WarmRoutes` now carries a
    `contextKey` (user + current farm) and posts `clear-data` when it changes, and warming
    always re-fetches instead of skipping on a hit. Isolation suite gains the
    competitor-card and bind-exactly-one-client assertions.

- **FleetWise F16 — Partner access scope + VAT registration** (migrations `0400–0402`;
  isolation-tested, `db:test` green; verified live against the demo project):
  - **What was actually happening.** An active `workshop_link` granted
    `app.has_farm_access` — the SAME predicate the farm's own staff are judged by.
    Measured on the demo farm, one contractor could read **12 machines, 32 cost entries
    (the farm's whole spend, including other contractors' invoices), 3 budgets, 11 fuel
    draws, 50 meter readings, the 5 other contractors with their phone numbers, and all 6
    farm users with names and emails**. A farmer connecting a tyre fitter to change two
    tyres was handing over their supplier list, staff directory and financials.
  - **`0400` — access is now a per-link CHOICE by the farm, defaulting to the minimum.**
    Baseline = the vehicles this partner is actually working on (a work request or a
    document of theirs against it) plus the faults/jobs on those vehicles and the requests
    sent to them. Four grants open exactly their own slice: `see_all_vehicles`,
    `see_service_history`, `see_costs`, `see_team`. **`partners` has NO grant** — a
    contractor never reads the farm's other contractors, because that is a competitor list
    with phone numbers and no consent makes it part of fixing a tractor.
    Implemented as `app.partner_scope(farm, key)` + `app.partner_machine_visible(farm,
    machine)`, folded into the existing `app.row_visible_to_role` so nine machine-keyed
    tables narrow at once and the rule lives in one place. **Existing links tighten** —
    the safe direction for a permission nobody consciously granted.
  - **`0402`** fuel draws carry `cost_cents`, so they follow the money grant too (found by
    measuring production after 0400: 6 rows still visible).
  - **`0401` VAT registration.** The document model assumed VAT always applies; for a
    partner below the SARS threshold that is a document claiming a tax they cannot
    collect. `workshops.vat_registered` → no VAT line anywhere (screen, PDF, totals), with
    a DB trigger forcing the rate to zero so a stale form or an import cannot issue VAT
    on a non-registered partner's behalf. The **rate stays editable either way** (SA went
    14%→15% in 2018; a 2025 rise was gazetted then withdrawn).
  - App: farm-side **"What they can see"** card per connected contractor on `/partners`
    (four plain sentences, not permission names; states the baseline so "all off" does
    not read as "they see nothing"; says outright that other contractors are never
    visible) + **disconnect** behind a confirmation. Partner settings gain the VAT-
    registration switch.
  - `rls_isolation.sql` **F16/F16b sections**: the default scope, each grant opening only
    its own slice (vehicles grant leaks no costs, costs grant leaks no people), all-grants
    still hiding the competitor list, a contractor unable to grant itself anything, the
    farm side completely unaffected, and the VAT guard forcing zero for a non-registered
    issuer while leaving a registered one alone. Every pre-existing workshop persona count
    was re-derived to the new model rather than relaxed. **Live proof**: contractor went
    12→4 machines, 32→0 costs, 5→0 competitors, 6→0 farm users, 50→0 readings, 6→0 fuel,
    while keeping its own 3 work requests and 3 documents; farm owner unchanged at 15/35/8/6.
  - i18n EN/AF at parity (**1,964 leaf keys**). Gates green; shared first-load JS flat at
    **102 kB**.
  - **Not built** (next tranche): the document TEMPLATE BUILDER (upload/compose your own
    layout) — the current customisation is letterhead + colours + terms + numbering +
    per-document editing; and the email layer, still the biggest gap against AutoVault.

- **FleetWise G1–G5 — the commercial layer made correct** (migrations `0403–0404`,
  `0410–0423`; merged as PRs #13/#15/#16; isolation-tested, `db:test` green; every
  migration applied to the demo project and driven live):
  - **Two P1 security fixes first.** `0403` closed four side doors (a user could read
    another user's `notifications`; Storage object visibility was not farm-resolved; the
    VAT guard sorted BEFORE the totals trigger so a stale form could still issue VAT;
    `wl_upd` matched zero rows and reported success). `0404` closed a **privilege
    escalation**: any signed-in user could `update users set role='rr_admin'` on
    themselves and read every tenant — reachable in production via
    `PATCH /rest/v1/users?id=eq.<self>`. `users_scope_ck` blocked the naive shape, which
    is why it never showed on a policy read.
  - **Who a document is FOR** (`0410`): billing identity on `farms` + `partner_clients`;
    `partner_documents.farm_id` nullable + `partner_client_id`; eight `bill_to_*` columns
    seeded by trigger and then editable, so a customer who moves premises next year cannot
    silently restate last year's invoice. Three recipient kinds — a linked FleetWise farm,
    a client from the partner's own book, or a **one-time customer typed straight onto the
    document** (a walk-in job should not require filing a customer before you can bill it).
  - **Correcting a mistake** — the thing AutoVault has no answer for (its route
    hard-DELETEs invoices). Four ways to be wrong, four different answers: delete a draft;
    **void** with a reason (it should not exist); a **credit note** (`0411–0412`,
    `0415`) or a **debit note** (`0416`, `0418`) for the amount; and — the founder's
    call, correctly — **edit the document in place** (`0417`, `0419`). The old version
    prefills the form, is snapshotted into `partner_document_revisions` (document + lines)
    with a reason, the new version replaces it, and `revision` links them. The guarantee
    moved from "cannot change" to "cannot change without leaving a complete record":
    freeze triggers refuse every other route, and `0420` makes the history **append-only**
    (grants revoked + a trigger that raises, rr_admin included; measured first — DELETE
    ran silently at 0 rows, which is default-deny, not an audit trail) and refuses to
    revise a **draft**, which is the one path that could have taken versions with it.
  - **Statements** (`0413`, `0421`), because a monthly-account farmer pays off a
    statement, not invoices. `app.partner_statement` / `app.partner_ageing` in SQL so the
    screen, PDF, CSV and emailed copy cannot disagree. **All six AutoVault statement
    faults fixed**: it had no opening balance, found credits by regex over free text,
    showed payments only once fully paid, INVENTED a payment at full value when paid with
    no amount, inflated the invoice debit by its own credit notes and then counted them
    again, and put quotes on a statement of account.
  - **Refunds and write-offs** (`0422–0423`), both found by walking the standard
    financial-control checklist. A refund is a **negative payment** (sign enforced by
    constraint; the rollup refuses refunding more than was ever paid), so a customer
    refunded a year ago stops sitting in credit for ever. A **write-off** goes through the
    same correction machinery (reason + kept version): it stays on the statement at full
    value AND posts its own credit line so the account **nets to zero**, leaves the ageing,
    stops being chased, and **stays in the farm's cost ledger** — not paying a bill does
    not undo the work. It survives payments moving underneath it (only full settlement
    reopens it) — caught by the isolation suite, which found that deleting a payment row
    put a written-off invoice back into the ageing.
  - **Email** (`0414`, Resend via a thin fetch, env-gated on `RESEND_API_KEY`/`EMAIL_FROM`):
    documents and statements go out as branded PDFs; every attempt logged, failures
    included, because a bounce nobody sees leaves the partner believing the customer was
    told. Plus a **customer-facing `/d/[token]` link** (zero anon DB), quote **expiry**,
    and overdue/expiring **reminders** on the nightly cron.
  - App: `/statements` (customer picker, period, ageing, send), `/documents/corrections`
    (every change ever made to a document that had already gone out), revise + version
    history + credit/debit/void/write-off/refund on the document page, and the statement's
    row wording moved **out of SQL into `lib/statement.ts`** — a statement posted to an
    Afrikaans farm was having half its lines written in English by a Postgres function.
  - `rls_isolation.sql` gains **G2–G5**. i18n EN/AF at parity (**2,211 leaf keys**).
    Gates green; shared first-load JS flat at **102 kB**.
  - **Known gaps, in order of who is blocked**: no **VAT-return (output VAT) report** for
    a period — a real blocker for a VAT-registered partner at filing time; no
    purchase/expense side (this is sales-only); no deposits, progress/milestone billing,
    recurring invoices, or online payment; no document **template builder** (customisation
    is letterhead + colours + terms + numbering + per-document editing).

- **FleetWise G6–G10 — the financial manager completed** (migrations `0430–0435`;
  isolation-tested, `db:test` green; every migration applied to the demo project and
  driven live):
  - **The purchase side** (`0430`). Everything before this was SALES. `partner_expenses`
    — supplier, their invoice number and date, category, ex-VAT cents with the supplier's
    OWN VAT amount captured alongside (a source document's VAT line is what may legally be
    claimed), and a `vat_claimable` flag for the VAT Act s17(2) blocks (entertainment,
    passenger vehicles, club fees). WORKSHOP-scoped like the client book: a farm reading
    what its contractor pays its suppliers would hand over their margin on every job.
    Capture form is a client component solely so the inclusive split shows live —
    R1 150,00 off a till slip becomes "R1 000,00 + R150,00" before you press anything.
  - **VAT return** (`0431`) — the gap most likely to send a partner back to a spreadsheet.
    `app.partner_vat_return`: output VAT (invoices + debit notes adding, credit notes
    subtracting, drafts/voids absent) less input VAT, on the **INVOICE BASIS** (time of
    supply = issue date, s9(1)) with that said in words on the screen. Real SARS **VAT
    periods** offered rather than a free range (`workshops.vat_category` A/B/monthly), because
    the wrong pair double-counts one month and omits another. A **written-off** invoice
    still declared its VAT — s22 bad-debt relief is a separate claim, so the return
    reports the amount and points at it rather than quietly making it. Screen + CSV (with
    every document and expense behind the figure) + PDF on the letterhead.
  - **Deposits and progress billing** (`0432`) — one mechanism, because a deposit and a
    progress payment are the same act to a ledger: an invoice for PART of an agreed job.
    Many invoices may point at one quote; `app.quote_billing` keeps it honest. Each stage
    carries its OWN lines and its own cost entry — **no netting, no deduction field**, so
    three invoices of R5 000 against a R15 000 quote put exactly R15 000 into the farm's
    ledger (asserted). Over-billing is flagged, not refused: jobs grow.
  - **Standing invoices** (`0433`) — the failure is forgetting, not mis-billing. Cadence +
    next date + lines; the nightly cron raises real documents. Generates a **DRAFT** by
    default (`auto_send` off), and **cannot run twice for the same period**
    (`last_period_start` is the idempotency key — a double-fired cron, a retry, and the
    partner's "raise it now" all go through it). Month arithmetic in its own function on
    both sides, checked against Postgres on 12 cases incl. leap years.
  - **Document layout** (`0434`) — not a designer: a closed set of choices (what things are
    CALLED, which blocks appear, density, accent style) applied identically by screen and
    PDF, with a DB trigger refusing unknown keys and a live miniature preview. A
    VAT-registered partner's invoice defaults to **"Tax invoice"** because s20(4) requires
    it to be headed as one. Frozen into `issuer_snapshot` with the letterhead.
  - **Online payment** (`0435`, PayFast, env-gated) — signature computed SERVER-side,
    checkout POSTed as a form (never a signed query string), and the callback believed only
    when the signature recomputes, the amount matches OUR record, and PayFast confirms the
    payload. A retried callback cannot credit twice: unique index on
    `(provider, provider_ref)`, not a check in the route. Signature verified against
    PayFast's own worked example, byte for byte. **The ITN itself is untested** — it needs
    live credentials and a real payment.
  - **A defect the browser found**: `toLocaleString("en-ZA")` gives "2 242,50" in Node and
    "2,242.50" in Chrome (trimmed ICU falls back to en-US). Every server-rendered amount
    and every client-rendered one disagreed, and any client component showing money
    hydrated with different text — React #418, which throws the server HTML away. `rands`
    and `num` are now written out by hand; verified on 18 cases and re-measured in the
    browser.
  - Also fixed this session: **every ConfirmDialog in the product was unreachable by
    keyboard** (the focus-trap selector matched `input[type=hidden]`, so focus stayed on
    the trigger outside the portal and Escape never reached the handler); initial focus now
    lands on the first field, never the destructive button. And the write-off dialog named
    `total − paid`, ignoring credit notes already raised.
  - `rls_isolation.sql` gains **G6–G10**. i18n EN/AF at parity (**2,454 leaf keys**). Gates
    green; shared first-load JS flat at **102 kB**.
  - **Still missing**: deposits/progress/recurring/VAT/expenses/layout/payments are now
    built, so the remaining gaps are narrower — no bank-feed import or reconciliation, no
    multi-currency, no payroll, and the PayFast callback is unexercised until credentials
    exist.


- **Verification pass + G11–G13** (migrations `0440`, `0450–0452`; isolation-tested,
  `db:test` green; everything below applied to the demo project and driven live):
  - **A debugging helper on the live database let anyone read as anyone.** Fingerprinting
    every object the migrations create against the hosted project found exactly one object
    on production and nowhere in the repo: `public._f14_probe(uuid)`, left from F14. It did
    NOT bypass RLS — `SECURITY INVOKER`, but its body called
    `set_config('request.jwt.claims', …)` with a uuid **the caller chooses**, and every
    policy decides through `auth.uid()`. So it moved the caller to the other side of the
    fence and let RLS answer correctly for somebody else, which is the more dangerous shape
    because every policy still "passes". Measured before removal: a Weltevrede operator
    (0 partner documents of their own) read back a contractor's 5/10/1 and the platform
    admin's 6/12/1. `anon` could execute it too — a function with no grant defaults to
    `EXECUTE TO PUBLIC` — and was stopped only by this schema's table grants.
    `0440` drops it and revokes that PUBLIC default from eleven `app.*` helpers that still
    carried it (**not** reachable — PostgREST exposes only `public`/`graphql_public` and
    answers PGRST106 for `app` — so recorded as defence in depth, not a live hole).
  - **`db:test` could never have caught it**: it builds a database FROM the migrations, so
    a production-only object is invisible. Three things change that: a **G11** suite
    section (nothing outside the test harness may rewrite `request.jwt.claims`; `_f14_probe`
    named explicitly; anon executes nothing in `app`), and
    **`scripts/schema_fingerprint.sql` + `docs/SCHEMA_DRIFT.md`** — one line per object
    across ten categories **including function grants**, which a body-only diff misses.
    G11 immediately earned itself by catching `app.stock_needs_reorder` with the same
    PUBLIC default, the first time the suite ran after it was added.
  - **Repo vs production is now provably identical**: 981 objects, 10 categories, all
    matching. The handover's fear of column/policy drift was unfounded — what looked like
    33 differing functions was three artifacts of a Windows checkout (CRLF in function
    bodies, a psql client-encoding mismatch turning em-dashes to mojibake, and production
    having comments stripped by how migrations were pasted). All three are documented in
    `SCHEMA_DRIFT.md` because they will catch the next person too.
  - **Two dead ends found by driving the screens, not reading them.** `vatPeriods` returns
    closed periods only, so an expense captured today fell in a period the screen refused
    to offer and `/vat` said "you have not captured anything you bought in this period" —
    which reads as "the capture failed". `currentVatPeriod` adds the open period, marked
    "still open", never the default. And `/recurring` said "you can raise one now" with no
    control to do it (it lives on the schedule's own page); the copy now says to open one
    and each due row carries the cue — as a `<span>`, because the row is already an anchor
    and a nested anchor is the invalid HTML that threw React #418 on the machines list.
  - **§4 of the handover, worked through**: `/expenses`, `/vat`, `/recurring`,
    `/contractor/settings` and progress billing all driven end-to-end with real writes.
    Proven live: a standing invoice pressed twice raises exactly ONE document
    (217 391 + 32 609 = 250 000 exactly); a 25% stage invoice books 103 250 — its own value,
    not the quote's — and a quote is never costed; a **sent** document keeps the letterhead
    frozen at send time while a **draft** picks up a newly saved layout; both PDFs generate.
    All ten nightly cron engines run clean against the live database (the HTTP route itself
    still needs `SUPABASE_SERVICE_ROLE_KEY` + `CRON_SECRET` in Vercel).
  - **§3 re-verified independently**: `rands()` renders identically in Node and Chrome
    across 22 cases; `advanceByCadence` agrees with `app.advance_by_cadence` on 12 cases
    including leap years; VAT periods have no gaps, no overlaps, correct category parity and
    real month-ends; PayFast's three signing behaviours (order preserved, PHP `urlencode`,
    empty fields omitted) all hold.
  - **Receipts for expenses (§4.6)** — the bucket, its policies and `receipt_path` existed
    since 0430; only the way to put a file there was missing, so a VAT-registered partner's
    every input-VAT claim was unsupported. Founder's call: **warn, never block** — the
    expense always saves, and the gap shows as an amount at the top of `/expenses`, a flag
    on the row, and a line on the VAT return before it is filed. Uploads go through the
    CALLER'S RLS client (the 0430 policies already scope the bucket by workshop), so no
    service key is involved. Measured live: signing TJ's receipt returns 200 for TJ and
    **400** for another contractor, for the farm TJ works for, and for anon. **G12** asserts
    the column and the write; the storage policies are not testable locally (0430 skips them
    where there is no `storage` schema) and that is said in the section.
  - **Stock on hand (§6 inventory; `0450–0452`)** — `parts_catalogue` was a list and could
    not answer "have we got one?". Shape is **F4's fuel model with different nouns**:
    `stock_items` + a `stock_movements` ledger, `on_hand` maintained by trigger and never
    typed. The money rule, chosen by the founder and asserted **both ways**: a receipt books
    nothing; an issue **naming a job card** books nothing (the 0211 line owns that rand —
    the no-double-count rule); an issue **with no job card** books a `parts` cost entry
    against the machine; adjustments and returns book nothing. Live: received 10 at R112 →
    no cost; issued 2 to the Claas Stroper → one entry of exactly 22 400. Contractors read
    0 items and 0 movements despite an active link. `0452` closes a gap the browser found:
    the policies admitted an **operator** to write while the server actions did not — UI-only
    enforcement, which F7 exists to rule out. Reading stays open to the whole farm side
    (a driver may ask "have we got a filter?"); the write narrows to owner/manager/mechanic.
    `0451` adds a low-stock nudge on the 0205 engine pattern, wired into the nightly cron.
  - i18n EN/AF at parity (**2 501 leaf keys**). Gates green; shared first-load JS flat at
    **102 kB**.
  - **Still not verifiable here** (all need secrets held by the founder): email has never
    sent (`RESEND_API_KEY`/`EMAIL_FROM`), the PayFast ITN round trip needs merchant
    credentials, and the cron HTTP route needs the service-role key. The PayFast signature
    was checked behaviourally rather than against PayFast's published worked example.

> Update this "current status" block at the end of every session.
