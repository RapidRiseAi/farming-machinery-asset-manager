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

> Update this "current status" block at the end of every session.
