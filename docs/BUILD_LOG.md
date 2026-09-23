# FleetWise, build log

The full chronological record of how this system was built, one entry per working
session, **oldest first**. Extracted verbatim from `CLAUDE.md` on 2026-09-12 at commit
`1193ef2`, where it had grown to ~249 KB and was being loaded into context on every
session regardless of the task at hand.

**This file is read on demand, not automatically.** For what is true *now*, current
phase, open items, and the operational rules this log taught us, see
[`../CLAUDE.md`](../CLAUDE.md). For per-feature status see
[`FLEETWISE_STATUS_CHECKLIST.md`](FLEETWISE_STATUS_CHECKLIST.md).

## How to read it

- **Entries are contemporaneous.** Each says what was believed and verified at the time
  it was written. Later entries supersede earlier ones without editing them, see the
  `CORRECTION, the Paystack Starter cap` entry, which states the reasoning: rewriting a
  wrong entry hides that it was ever wrong. Where two entries disagree, **the later one
  wins**.
- **The cap thread is fully resolved and every mention of it above the last entry is
  wrong.** Rapid Rise AI is a Paystack *Registered Business* with no collections cap.
  R80 000 (recorded here) and ZAR 1 000 000 (Paystack's published Starter figure) were
  both wrong for this account.
- **Searching beats reading.** At ~3 000 lines this is a reference, not a narrative.
  Grep for a migration number (`0481`), a commit (`bcbd39c`), or a feature code (`F14`).

## Why entries are shaped the way they are

Each entry records what was *measured*, not what was intended, migrations applied,
suites run, gates green, and explicitly what was left undone and why. That convention is
worth keeping: most of the operational rules now at the top of `CLAUDE.md` were only
recoverable because the entry that learned them wrote down how it found out.

---

**Phase: v1 backend complete (Weeks 1-3).** Deployed to production on Vercel (`main`).

Done:
- Repo skeleton; scope at `docs/SCOPE.md`.
- Full Section 6 schema (incl. v1.5 fuel tables); money-in-cents, soft-delete, audit
  trigger, job-card lock + totals triggers. `supabase/migrations/0001-0008`.
- RLS helpers + policies for **every** table; **green isolation tests** (`pnpm db:test`).
  `0100-0102`, `0200` (storage buckets).
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

- **Week 2-3 backend (migrations 0202-0204; verified live + isolation-tested):**
  service **due engine** (`app.recalc_machine_service`/`recalc_all_due`, meter trigger);
  **job cards** end-to-end (create/lines/complete/approve→lock, completion side-effects:
  service-line reset, meter capture, watch item, fault resolve); **faults** (in-app +
  QR, fault→job); **watch items**; **dashboard** (service board/spend/faults/stale);
  **reports** 1-4 + cost CSV; **notifications** queue (fault/job triggers) + in-app centre;
  **users/invites** (Auth admin) + deactivate; **settings** RPC (owner-editable).

- **UI/UX rework + v1 completion (this mission, branch `claude/farmgear-ui-ux-backend-th78c7`):**
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
- WhatsApp Stage 2 (BSP API), Stage 1 manual; in-app centre + `deliver_after` queue ready.
- Wire the nightly cron in the Vercel project + set `CRON_SECRET` (route + docs shipped).
- v1.5 diesel/fuel module (tables + RLS exist; no features), out of v1 scope.
- Runtime click-through against the live DB (this session verified boot/render/guards with
  placeholder env; `.env.local` with live creds was absent in the fresh clone).

Env/dashboard follow-ups: delete the empty `menu-media` bucket; optional Auth
leaked-password protection. Dev logins: `admin@farmgear.dev`, `danie@weltevrede.example`
(both `FarmGear!dev1`).

- **FleetWise F1, Cost & TCO spine (migrations `0210-0211`; branch
  `claude/fleetwise-cost-tco-spine`; isolation-tested, `db:test` green):**
  - `cost_entries` ledger (types purchase/finance/fuel/parts/labour/invoice/other,
    ex-VAT cents, nullable `machine_id` for farm-level fuel, composite FK, full RLS +
    grants + audit). SECURITY-DEFINER sync triggers keep it in step with
    `job_card_lines` (parts/labour/other), `machines` (purchase price + derived finance
    interest) and `fuel_deliveries` (farm-level fuel); idempotent backfill for existing
    rows. `app.machine_tco()` rollup. Machine finance fields added.
  - App: real **TCO** on machine detail (+ cost breakdown + finance card) and **ranked
    by TCO** in reports; **cost-per-hour & cost-per-km on a consistent lifetime basis**
    (shared `src/lib/cost.ts`, fixes D-2/D-3, detail and reports now agree); true
    per-machine **"breaks most often"** (FR-11.2) + **per-site/group** report filter
    (FR-11.3, graceful pre-F7); job-card **quote/invoice/photo upload** with invoice
    amount → `invoice` cost entry (FR-8.4, service-role media route + `jobcard-photos`).
  - Rename **FarmGear → FleetWise** across touched UI/metadata (layout, manifest,
    `env.APP_NAME`, i18n `app.name`, README, PDF wordmark). i18n EN/AF at parity
    (466 keys). Bucket ids + `farmgear:` localStorage prefixes kept stable.

- **FleetWise F4, Fuel module (migrations `0240-0242`; branch
  `claude/fleetwise-fuel`; isolation-tested, `db:test` green):**
  - Fuel-cost model = **per-issue attribution** (no double-count): fuel enters the
    TCO ledger ONLY via `fuel_issues` (per-machine `fuel` cost_entry, `machine_id`
    null → farm-level); the F1 `0211` `fuel_delivery`→cost trigger is **replaced** to
    book nothing (deliveries are tank stock) and to soft-delete any pre-existing
    delivery-sourced fuel entry. Result: a farm's fuel appears in `cost_entries`
    **exactly once**, asserted in `rls_isolation.sql` (F4 section). Capture columns
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

- **FleetWise F5, Plans & entitlement gating framework (migrations `0250-0251`;
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
    decision, indicative monthly/annual subtotal shown; **no charging**).
  - **Billing seam** `src/lib/billing/*`: `BillingAdapter` interface + env-gated
    (`BILLING_PROVIDER`) **no-op adapter** returning `{deferred:true}`, clean plug-in
    point for the provider chosen after research. No real provider wired.
  - Demo seed farm set to **Complete/annual** so every gated surface demos. i18n EN/AF
    at parity (**628 keys**; `plan.*`, `billingPeriod.*`, `upgrade.*`). `rls_isolation.sql`
    F5 section proves plan gating, cross-tenant isolation, anon-deny, and the
    asset-count trigger. Gates green (typecheck + lint + build + `db:test`); shared
    first-load JS flat at **102 kB**.
- **FleetWise F6, Compliance reminders & Web Push (migrations `0260-0263`; branch
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

- **FleetWise F10, Vehicle capture completeness + images (migration `0280`; branch
  `claude/fleetwise-vehicle-capture`; isolation-tested, `db:test` green):**
  - **Primary vehicle image**: `machines.primary_attachment_id`, a **composite FK** to
    `attachments(id, farm_id)` so a machine can only point at a photo of its OWN farm
    (nullable → graceful placeholder). Rendered on the **machines list** (cards + a new
    desktop thumbnail column, batch-signed URLs) and the **detail header** (signed URL,
    placeholder fallback). `MachinePhotos` reworked into a gallery with **set/unset
    primary** (server actions + `revalidatePath`; primary-first ordering, ring + badge)
    and full i18n/locale.
  - **Full capture on add** (FR-3.2/3.4): `cost_centre` + `department` capture columns
    added to `machines`, `MachineFields` (new "Grouping" section), `createMachine`/
    `updateMachine`; shown in the detail identity card; added as **distinct-value dropdown
    filters** on the machines list. **Primary photo upload during add**, a client-
    compressed base64 data URL ferried through `createMachine`, uploaded via the RLS
    server client and marked primary (`serverActions.bodySizeLimit` → 4 MB). Finance
    (F1) + warranty/licence (F1/F6) + assigned operator (F3) capture kept intact.
  - Shared client `src/lib/image-compress.ts`; server `src/lib/machine-photo.ts` uploader;
    demo seed gains cost-centre/department. i18n EN/AF at parity (**698 leaf keys**).
    `rls_isolation.sql` F10 section proves the primary reference stays farm-isolated
    (composite-FK cross-farm reject) + capture-column tenant isolation. Storage stays
    farm-scoped (`{farm_id}/{machine_id}/…`, signed URLs); anon zero-DB unchanged. Gates
- **FleetWise F9, Service kits & parts catalogue (migrations `0270-0271`; branch
  `claude/fleetwise-service-kits`; isolation-tested, `db:test` green):**
  - **`parts_catalogue`** (part_no, description, supplier, category, `typical_cost_cents`
    ex-VAT, nullable `farm_id` = GLOBAL/RR-seeded row), tenancy mirrors `service_templates`
    (global rows readable by all authenticated; per-farm rows RLS-scoped) + grants + audit +
    soft-delete. Manual CRUD at **/parts** (owner/manager/mechanic for their farm; RR admin
    for the global library), with search + VAT-inclusive→ex-VAT capture.
  - **`service_kits`** (per machine, or a machine_type template; scope check enforces one)
    **+ `service_kit_items`** (catalogue-part ref or free part_no + qty + ex-VAT unit cost);
    farm-scoped RLS + composite FK + audit + soft-delete. Machine-detail **"Service kit"
    card**: create kit, add/edit/remove items (pick from catalogue → snapshot, or free part).
  - **"Add from catalogue"** on job-card line entry (prefills part_no/description/ex-VAT cost)
    + **"Apply kit"** on a job card → appends one `job_card_line` per item; those flow to
    `cost_entries`/TCO + history via the **existing 0211 trigger** (the ONLY kit→cost path -
    **no double-count**, asserted in `rls_isolation.sql` F9 section). Parts nav item + icon;
    demo seed gains a catalogue + a 250h kit. i18n EN/AF at parity (**724 leaf keys**). Gates
    green (typecheck + lint + build + `db:test`); shared first-load JS flat at **102 kB**.

- **FleetWise F12a, Contractor spine & Partners directory (migrations `0300-0301`;
  branch `claude/fleetwise-contractor-spine`; isolation-tested, `db:test` green):**
  - **Contractor typing on the existing workshop spine**: `contractor_kind` enum
    (mechanic/auto_electrician/parts_supplier/panel_beater/tyre/towing/other) + structured
    contact columns (`phone`/`whatsapp`/`email`/`area`) added to `workshops` (0300; additive,
    default kind 'other'; existing 0101 RLS + 0008 audit unchanged). A contractor/supplier
    stays a `workshop`; staff are `workshop`-role users reaching linked farms via
    `workshop_links` (the one-account→many-farms spine, extended, not replaced).
  - **`partners`** table (0301): find/add/quick-contact/connect directory. Tenancy mirrors
    `service_templates`/`parts_catalogue`, GLOBAL suggested rows (`farm_id` null,
    `is_suggested` true, RR-curated) readable by all authenticated; farm-owned rows via
    `app.has_farm_access`. **Mutation restricted to the owning farm's owner/manager (or RR
    admin for globals)** via `app.current_app_role()` in the policies. `(farm_id IS NULL) =
    is_suggested` check-constraint invariant; nullable `workshop_id` link (set once joined);
    grants + audit + soft-delete; anon zero-DB.
  - **Invite / connect flow** (`inviteContractor`, service-role, workshops/users are
    RR-admin-only under RLS): from a farm-owned partner, owner/manager creates/reuses a
    `workshop` (carrying the partner's kind + contacts), an **active** `workshop_link` to the
    farm, a confirmed `workshop`-role user, and a **magic login URL** (`auth.admin.generateLink`)
    to hand over, deep-links to `/auth/callback?next=/machines`. Idempotent (reuses the linked
    workshop, re-activates a revoked link, skips existing profiles). No guessable bypass -
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
- **FleetWise F11, Vehicle checklists & template builder (migrations `0290-0291`;
  branch `claude/fleetwise-checklists`; isolation-tested, `db:test` green):**
  - Mirrors **RapidRiseAi/TJ-autovault**'s inspection template→report pattern
    (`inspection-template-builder` / `inspection-report-form-renderer` /
    `inspection-templates-table` / `lib/inspection-reports` / `*inspection_*` migrations),
    adapted to FleetWise house rules. Field-type model widened per spec §7 to
    **checkbox / text / number / photo / rating / section_break** (TJ's dropdown dropped;
    photo + rating added).
  - **`checklist_templates`** (farm-owned, or GLOBAL/RR-library when `farm_id` null -
    visibility mirrors `service_templates`/`parts_catalogue`) **+ `checklist_template_fields`**
    (ordered; `farm_id` mirrors the parent, composite FK keeps FARM fields isolated; plain
    FK cascades). **`checklist_instances`** (per machine; optional `job_card_id` composite FK
    + nullable `work_request_id` reserved for F12) **+ `checklist_instance_values`** (one row
    per field at fill time, value + note + optional **photo attachment** via a composite FK
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

- **FleetWise F12b, Work-request flow (migrations `0310-0311`; branch
  `claude/fleetwise-work-requests`; isolation-tested, `db:test` green):**
  - **`work_requests`** (farm-initiated jobs to an assigned `workshop`): `kind`
    (repair/quote/inspection/parts/other), full status lifecycle enum
    `requested→viewed→quoted→accepted→in_progress→completed→invoiced→closed`,
    `priority`, `title`/`description`, ex-VAT `quote_amount_cents` +
    `invoice_amount_cents` + `vat_rate_bps`, `job_card_id` link. **`work_request_events`**
    (from/to status + note + by_user) drives the timeline. farm_id + composite FKs
    (machine + job_card), RLS via `app.has_farm_access` (covers farm crew AND the linked
    workshop, the assigned contractor sees/updates exactly the farms they serve), audit,
    soft-delete, grants, anon-zero-DB. `attachments.parent_type` widened to `work_request`.
  - **Invoice → cost, no double-count** (0311, SECURITY DEFINER): setting
    `invoice_amount_cents` UPSERTS a **single** `invoice` `cost_entry` keyed
    `(source_type='work_request', source_id)` → flows into machine TCO; re-edits update in
    place, clearing/deleting soft-deletes it, and a **quote is never costed**. This is the
    ONLY work-request→cost path; converting to a job card books nothing here (the job
    card's own lines cost via the 0211 path), so the two never double-count, asserted in
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

- **FleetWise F12c, Contractor aggregated dashboard & per-kind views (migration
  `0320`; branch `claude/fleetwise-contractor-dashboard`; isolation-tested, `db:test`
  green):**
  - **Aggregated contractor dashboard** (`/contractor`): a `workshop`-role user gets ONE
    dashboard listing **every `work_request` assigned to their workshop across ALL linked
    farms**, the one-account→many-farmers value prop. Farm isolation is RLS's job
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
    panel_beater/tyre/towing → theirs) and tagline, shared components, differing default
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
    ONE example feature, the **client-analytics** panel (per-client rollups) shows for
    `pro`, an upgrade nudge for `free`. Demo workshop set to `pro`.
  - i18n EN/AF at parity (**973 leaf keys**; `contractor.*`, `contractorPlan.*`,
    `nav.contractor`/`nav.groupContractor`). `rls_isolation.sql` F12c section (fresh Farm E +
    Workshop X) proves aggregation across ≥2 linked farms, own-workshop-only filtering on a
    SHARED farm (RLS lets W see X's row; the workshop_id filter excludes it), unlinked-farm
    invisibility even for a request assigned to the workshop, a cross-tenant write denial,
    and the plan column default. Gates green (typecheck + lint + build + `db:test`); shared
    first-load JS flat at **102 kB** (`/contractor` 105 kB).
  - **Not built** (later): owner inbox (F13, concurrent), multi-site (F7).
- **FleetWise F13, Owner/manager activity inbox + fleet analytics + reminders
  (migration `0330`; branch `claude/fleetwise-owner-inbox`; isolation-tested,
  `db:test` green):**
  - **Activity inbox** (`/inbox`, owner/manager only): a unified, actionable feed built
    on `work_requests` + `work_request_events` + `notifications` (surfaces the notification
    engine, does NOT duplicate it). Outstanding quote/invoice value stats; a **"Needs your
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
    table, all farm-scoped, retired/sold excluded (via `reports/data.ts` `allowed` set).
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

- **FleetWise F8, POPIA, security & backup (migration `0350`; branch
  `claude/fleetwise-popia-security`; isolation-tested, `db:test` green; NFR-2/3/4):**
  - **Docs** (the NFR-2/4 documentation deliverables): `docs/POPIA.md` (personal-data
    inventory across users/auth/usage_logs/faults/attachments/audit_log; lawful bases;
    retention & deletion policy incl. the **AARTO legal-obligation** + **audit-log**
    retention exceptions, documented; cross-border-AI consent+DPA stance per founder
    decision #2; data-subject rights + operational checklist), `docs/SECURITY.md` (RLS as
    the **sole** tenant-isolation guarantor proven by `rls_isolation.sql`; grants/least-
    privilege; encryption in transit/at rest + bcrypt creds, inherited vs configured;
    service-role key server-only handling; zero-anon-DB public-QR property; leaked-
    password toggle + live-project verify list), `docs/BACKUP.md` (Supabase Pro daily
    backups/PITR runbook, PITR + full-project + schema restore procedures, **99.5% uptime
    target** + RPO/RTO, post-restore smoke checks incl. **re-applying erasures after a
    PITR rewind**, quarterly **restore-drill checklist**).
  - **Data-subject rights RPCs** (`0350`, SECURITY DEFINER, `search_path` pinned):
    `public.export_personal_data(uuid)` (DSAR → full JSON bundle: profile + usage_logs +
    meter_readings + faults + job_cards + cost_entries + attachments + notifications +
    audit actions) and `public.erase_personal_data(uuid,text)` (**anonymise, not hard-
    delete**, clears name/email/phone, deactivates + soft-deletes, nulls free-text name
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
- **FleetWise F7, Multi-site + per-role visibility (migrations `0340-0341`; branch
  `claude/fleetwise-multisite`; isolation-tested, `db:test` green, the MOST tenancy-
  sensitive change; every prior isolation assertion kept green, model extended not weakened):**
  - **Multi-site (FR-1.5)**: new **`user_farm_memberships`** spine (`user_id`,`farm_id`,
    `role`,active,soft-delete; role-check excludes rr_admin/workshop; unique per user+farm;
    RLS + audit + grants + anon-zero). `app.accessible_farm_ids()`/`app.has_farm_access()`
    rewritten to **UNION active memberships** ON TOP of the primary-farm + workshop-link
    paths, **purely additive** (`users.farm_id` stays the default/primary; idempotent
    backfill of a membership per current farm user makes the new union == old behaviour, so
    the isolation suite's directly-seeded users still resolve via the primary path). The
    workshop path (`workshop_links`) is untouched. Membership `active=false` immediately
    removes access (dynamic scoping, like `workshop_links`).
  - **Per-role visibility (FR-2.3/FR-8.1), enforced in RLS not just UI**, helpers
    `app.row_visible_to_role(farm,machine)` + `app.work_request_visible(wr)` (SEC DEFINER,
    search_path pinned, execute revoked from public/anon). **Operators** see only machines
    where `assigned_operator_id = auth.uid()` and only those machines' child rows
    (`machines`,`meter_readings`,`service_plan_lines`,`faults`,`job_cards`,`watch_items`,
    `fuel_issues`,`usage_logs`,`licences`,`work_requests`); owner/manager/mechanic keep full
    farm access (the predicate reduces to `has_farm_access` for every non-operator, so no
    seeded persona's counts change). **Contractors (workshop)** now see **and may update**
    only work_requests assigned to their own workshop (+ their events + `work_request`
    attachments), closing the F12c gap where the workshop_id filter was app-only. Farm crew
    keep full access.
  - **App layer**: `accessibleFarms()`/`currentFarmId()` + `CURRENT_FARM_COOKIE` in
    `lib/auth.ts` (validated cookie choice, default primary; null for rr_admin/workshop);
    `setCurrentFarm` server action; **`SiteSwitcher`** in the shell (desktop sidebar + mobile
    bar) shown only when the account reaches >1 farm; **dashboard + machines list + reports
    (page & all 6 CSV routes) scope every farm-keyed query to the current farm** (completes
    FR-11.3; single-farm users unaffected, RLS already scopes them). Team/settings stay on
    the primary farm (documented boundary).
  - `rls_isolation.sql` **F7 section** (fresh Farms F/G/H): multi-site union sees exactly
    F∪G never H, membership revoke removes G while primary F holds, membership table
    own-user/farm-admin isolation + anon-deny + non-admin cannot self-grant; operator sees
    only the assigned machine + its child/work rows and is denied a non-assigned one; two
    contractors on a **shared** farm each see/mutate ONLY their own request. **Reconciled
    F12c** (the one place an assertion encoded the now-fixed leak): W no longer sees X's
    request on a shared farm, RLS enforces workshop-scoping. i18n EN/AF at parity
    (**1012 leaf keys**; `nav.switchFarm`). Gates green (typecheck + lint + build +
    `db:test`); shared first-load JS flat at **102 kB**. Migrations **0340-0341** only.

- **FleetWise G1, Budgets & utilisation analytics (migrations `0360-0361`; branch
  `claude/fleetwise-budgets-analytics`; isolation-tested, `db:test` green; FR-10.4/10.5,
  §23):**
  - **Budgets + budget-vs-actual (FR-10.4)**: new **`budgets`** table (`0360`), a spend
    target (ex-VAT cents) for a period, optionally narrowed to one machine and/or one cost
    category (both nullable, like `cost_entries.machine_id`). `period_type`
    (month/quarter/year) + explicit `period_start`/`period_end`; farm-scoped RLS
    (`has_farm_access`) + composite FK + audit + soft-delete + grants; a `NULLS NOT
    DISTINCT` unique index dedupes each scope+period. **Actual is never stored**, summed
    live from the F1 `cost_entries` ledger over the budget's own scope+period (shared
    `src/lib/budgets.ts`, so machine-detail + reports agree), with over/near/under
    indicators. UI: machine-detail **Budgets card** (owner/manager CRUD via
    `budget-actions.ts`) + reports **Budget-vs-actual** table + `budgets.csv`.
  - **Utilisation (§23)**, hours/km **used vs idle** over a window, in `src/lib/analytics.ts`
    (documented): `used = last meter reading on/before `to` − baseline (last reading
    on/before `from`, else first in-window)`; `available = window-days × capacity/day`
    (farm settings `utilisation_hours_per_day`/`_km_per_day`, defaults 10 h / 200 km);
    `pct = used ÷ available`; `idle = available − used`. Machine detail shows a trailing
    90-day card; reports a per-machine column (window = report period, or trailing 90 d for
    "all time").
  - **Downtime per asset (§23)**, days a machine was **in_workshop/out_of_service**,
    reconstructed in SQL (`0361 app.fleet_downtime`/`app.machine_downtime_days`, SECURITY
    INVOKER so audit_log RLS scopes it) from the **audit_log status trail** (INSERT status +
    every status-changing UPDATE, each status held until the next event or now(), clipped to
    the window; `public.*` PostgREST wrappers, execute revoked from anon). Shown on machine
    detail + reports (utilisation table).
  - **Repair-vs-replace (FR-10.5)**: `repairVsReplace()` flags "consider replacing" once
    lifetime **repair spend (parts+labour+other+invoice) ÷ purchase price** ≥ a farm-
    settings threshold (`repair_replace_pct`, default 60%), badge + ratio on machine-detail
    lifetime stats.
  - Settings gains an **Analytics & budgets** card (repair-replace % + utilisation
    capacity). Demo seed gains 3 budgets (one over) + a 12-day New Holland downtime trail.
    i18n EN/AF at parity (**1071 leaf keys**; `budget.*`/`budgetPeriod.*`/`util.*` +
    `machine.*`/`settings.*` additions). `rls_isolation.sql` G1 section proves `budgets`
    farm isolation + cross-tenant/anon write denial, and downtime reconstruction + its
    farm-scoping (Owner B sees 0 for a Farm A machine) + anon execute-deny. Gates green
    (typecheck + lint + build + `db:test`); shared first-load JS flat at **102 kB**.
    Migrations **0360-0361** only.

- **UI/UX redesign, Phase 0: the six code defects** (branch `claude/fleetwise-ui-redesign-l4ng55`;
  no migration, no backend behaviour change; gates green):
  - Design handoff committed at `design_handoff_fleetwise_ui_upgrade/` (22-screen redesign +
    176-finding audit + build order + tokens). Phases 1-3 (shared components, then the five
    daily-loop screens, then the rest) are **not** started.
  - **Bug 1** onboarding step 3 ("put QR stickers on") shared step 1's `machines > 0` and ticked
    itself. It now has its own condition, an explicit acknowledgement stored as
    `farms.settings.qr_labels_printed_at` through the **existing** owner/manager-guarded
    `update_farm_settings` RPC (0204, jsonb `||` merge), so no schema/RLS change; undoable.
  - **Bug 2** every pre-auth `t()` ran with no locale (login, public QR), so a bilingual product
    opened in English for every Afrikaans farm. New `src/lib/locale.ts` `deviceLocale()`
    (cookie `fw_lang` → `Accept-Language` → `en`), `setDeviceLanguage` action + visible
    `DeviceLanguageSwitcher` on login and `/m/[token]`, `<html lang>` now follows it, and the
    signed-in `setLanguage` mirrors the profile choice into the same cookie. The QR route reads
    a cookie and a header only, **zero-anon-DB unchanged**.
  - **Bug 3** `impersonateFarm` writes an audit row and nothing else, no farm context, no
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
  - **Bug 6** the CSV header failure rendered `name_required, previewTitle` ("Name is required -
    Preview"). `validateCsv` now returns `headerFound`, and empty-file vs missing-name-column get
    their own messages naming the columns actually present.
  - New shared UI: `ConfirmDialog` (bottom sheet on phones, centred modal from `sm`; optional
    type-to-confirm; 48px targets; icon **and** word) on a new `align="responsive"` in
    `dialog.tsx`, plus `TrashIcon`. i18n EN/AF at parity (**1203 leaf keys**). Shared first-load
    JS flat at **102 kB**.

- **UI/UX redesign, Phases 1-3** (branch `claude/fleetwise-ui-redesign-l4ng55`; no
  migration, no backend behaviour change; gates green; shared first-load JS flat at **102 kB**):
  - **Phase 1, shared components** (where ~60% of the audit lives). `badge.tsx` gains an
    eight-glyph **shape vocabulary** + per-enum maps so status is always **shape + word +
    colour**; new `components/ui/status.tsx` exposes one badge per domain enum (machine,
    job, fault, urgency, work, priority, expiry, budget, fine, service), 19 call sites
    converted, 3 local `statusTone` helpers deleted. New **`lib/format.ts`** (thousands
    separators, unit words, relative dates, role labels, `vatPercent`/`percentToBps`).
    `empty-state.tsx` splits into **`AllClear` / `GetStarted` / `NoMatches`**. `field.tsx`
    gains **`TextField`/`SelectField`/`TextareaField`**. New **`FilterChips`/`ActiveFilters`**
    (same URL params). Buttons step **down** at `sm` (48px mobile → 40-44px desktop).
    All 12 destructive actions now go through `ConfirmDialog`.
  - **Phase 2, the daily loop.** **Farm home**: seven counters → one ranked "Needs your
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
  - **Phase 3, the rest.** **Shell**: 3 sidebar groups + "Everything else", permanent green
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
    never posted `farm_id`, which `createJobCard` requires, the button failed with
    "Missing machine" and created nothing. Fixed; the form now also lets you pick the job
    **type** instead of hardcoding `repair`. `JOB_TYPES`/`JOB_STATUSES`/`LINE_KINDS` moved to
    `lib/job-options.ts` (a `"use server"` file may only export async functions).
  - i18n EN/AF at parity (**1489 leaf keys**).
  - **Still awaiting sign-off** (both flagged in the handoff as behavioural): real
    impersonation state (farm-context cookie + `exit` log), Phase 0 left the copy honest;
    and the operator landing (`requireRole` → `/dashboard?error=forbidden`, never rendered).
    Deferred by request to the later backend/security pass: `/partners` rendering a
    contractor login URL as copyable plain text, and CSV **column mapping** on import.

- **Backend & security pass** (branch `claude/fleetwise-ui-redesign-l4ng55`, restarted from
  the merged `main`; **no migration**; gates green; shared first-load JS flat at **102 kB**):
  - **Contractor login link was a credential in a query string.** `inviteContractor` /
    `sendLoginUrl` redirected to `/partners?…&loginUrl=<action_link>`. A Supabase
    `action_link` is a BEARER credential, whoever holds it signs in as that contractor
    and reaches every farm they are linked to, and a query string lands in browser
    history, access logs, the `Referer` header and the address bar. Now a short-lived
    **httpOnly, SameSite=Strict cookie** scoped to `/partners` (`src/lib/partner-link.ts`,
    10-min TTL), read once by the server render, cleared by an explicit "done with it"
    action. The card says plainly that the link signs someone in, names who, and when it
    dies.
  - **Open redirect on `/auth/callback`**: `next` was concatenated onto the origin
    unchecked (`//evil.com`, `/\evil.com`). New **`src/lib/safe-path.ts`** `safePath()` -
    single leading slash, no scheme-relative form, re-checked after decoding, used by the
    callback AND by the three `back` form fields in `team/actions.ts` that were also
    unvalidated redirect targets. 12 cases proved incl. `%2f%2f` / `%5C%5C` bypasses.
  - **S11 operator landing (was awaiting sign-off).** `requireRole` sent EVERY denied user
    to `/dashboard?error=forbidden`, for an operator, the owner's money page, and
    `forbidden` was never rendered. New **`homePathFor(role)`** is the single source of
    truth; `requireRole` bounces to the role's own home with `?denied=1`, rendered as a
    sentence on `/driver`. New **`/home`** dispatcher for post-login + magic link (a link
    minted pre-sign-in cannot know its role). Settings/onboarding bounces follow suit.
  - **S10 support mode (was awaiting sign-off).** Entering now pins the farm in an
    httpOnly cookie that `currentFarmId` honours for rr_admin (`SUPPORT_FARM_COOKIE`,
    `supportFarmId`/`supportFarm`), so every farm-scoped surface narrows to that customer;
    a **`SupportBanner`** names the farm on every screen and exits in one tap; leaving
    writes the paired **`exit`** audit row via the existing RPC, so the log shows duration.
    A NARROWING not a grant, rr_admin already reads all farms via `app.is_rr_admin()`, so
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
    "Afrikaans" while showing "AF" (WCAG 2.5.3 Label in Name); and `?error=no-profile` -
    what the guards append when nobody is signed in, rendered as "That didn't work."
  - i18n EN/AF at parity (**1512 leaf keys**). Smoke test kept at
    `scratchpad` (not committed); re-runnable with a placeholder `.env.local`.
  - **Live click-through against the hosted demo project** (`nmqtcvdwtyggxjjgtnzm`; the
    last remaining gap, every earlier run used placeholder env, so no query, no RLS
    decision and no role dispatch had ever actually executed). Demo logins are in
    `docs/FLEETWISE_MANUAL_SETUP_GUIDE.md` (password `FleetWise!demo1`). Signed in as
    owner / operator / contractor / rr_admin and drove the built app:
    - **Role dispatch**, `/home` forwards owner→`/dashboard`, operator→`/driver`,
      workshop→`/contractor`, rr_admin→`/admin/farms`. An operator opening `/settings`
      lands on `/driver?denied=1` and reads a sentence, not the owner's money page (S11).
    - **Support mode (S10) end to end**, entering narrows the machine list from **15
      (all farms) to 3** (Rooikoppies), the banner names the customer and follows across
      screens, exit clears it, and `audit_log` holds a farm-scoped `impersonate`/`exit`
      **pair** seconds apart, so the log shows duration. A garbage `fw_support_farm`
      cookie falls back to the un-narrowed rr_admin view, it is a narrowing, not a grant.
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

- **Accessibility pass, the 48px floor and icon+word, measured not asserted** (same
  branch; no migration; gates green; shared first-load JS flat at **102 kB**):
  - **How it was found.** A Playwright pass measured the *rendered* height of every
    `button`/`select`/`[role=tab]` on a Pixel 5 across all four roles (25 route loads).
    Grepping Tailwind classes had said the floor held; measuring said **155 controls were
    under 48px**. The floor lived in `button.tsx` alone, every other primitive was still
    44px, so the rule was true of buttons and false of everything beside them.
  - **Raised at the source**, each stepping down only at `sm:` (where there is a mouse):
    `input.tsx` `controlBase` (→ Input/Select/Textarea, the biggest single win),
    `filter-chips`, `nav`, `tabs`, `device-language-switcher`, `site-switcher`,
    `print-button`, `fault-capture`, the `/reports` period + site controls. `Button`'s
    `sm` no longer steps down on a phone at all (48px), only on desktop.
  - **Emoji were standing in for icons** in 5 files (`📷 🎤 ⏹ 📍 🔒 ☑ ✓`), they render
    differently per Android skin, ignore `currentColor`, and read aloud as their unicode
    name. Added **CameraIcon/MicIcon/StopIcon/PinIcon/LockIcon/SquareIcon** at the set's
    1.75 line weight and replaced every one.
  - **Icon-only controls eliminated**: dialog close, toast dismiss and the alerts bell all
    carry their word now. The **offline pill** showed its label only from `sm:` up, on a
    phone "are we offline?" was answered by a coloured dot alone.
  - **S22 (checklist template builder) had never been through the redesign**, raw markup,
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
    session begins, the password action and the magic-link callback, both of which may
    set cookies, which a Server Component may not. A deliberate choice always wins and
    corrects the cookie; an unconfigured profile adopts the device choice and stamps it,
    which is what stops a shared farm-office PC re-languaging the next person.
  - **Tone (friendly vs professional)**, per person, independent of language. An OVERLAY
    (`en.professional.json`/`af.professional.json`, 141 keys each) over the one dictionary
   , no third and fourth translation to keep at parity, and a professional-tone user
    cannot hit an untranslated string. `Lang` widens `Locale` (`"en"|"af"|"en-pro"|"af-pro"`)
    so **`t(key, locale)` is unchanged at every call site**; pages read the composed
    `profile.lang`, the EN/AF control reads `profile.language`. `format.ts` compares
    `localeOf(locale)`, otherwise an af-pro user's dates format in English.
  - **"What is this?" on every page** (`PageInfo`/`PageInfoButton`, `pageInfo.*`): what the
    screen is for, what you can do, and a note where it matters. Also the tour's re-entry.
  - **Filters**: the machines list stacked 4 unlabelled chip rows (~200px before the first
    machine, group names only in `aria-label`). New `FilterBar`, one control with a count,
    named removable pills, groups behind a disclosure with visible headings; same URL
    params. Applied to machines/jobcards/work. Chips are `<Link>`s now, which navigate
    before hydration and prefetch. (They replaced a `router.push` version observed not
    navigating; the cause was never established, `router.push` works everywhere else,
    including same-route query changes on a segment with a `loading.tsx`, so treat it as
    unexplained, not a known Next defect.) Dead `filter-chips.tsx` removed.
  - **Loading**: only 3 of 31 route segments had a `loading.tsx`; all do now, from a shared
    `PageSkeleton`. Plus a top `RouteProgress` bar (links + server-action submits) and the
    app's first `error.tsx`.
  - **/install**: the PWA install path, honest that there is no file, real button via
    `beforeinstallprompt`, spelled-out iOS steps, already-installed state; says what works
    with no signal. Reachable from nav for every role.
  - **Walkthrough** (`src/lib/tour.ts` + `src/components/tour.tsx`): cards, not DOM
    spotlights, each ends in a link to the real screen, progress saved per step in
    localStorage so leaving resumes. Role-aware (owner 8 / driver 6 / contractor 5 /
    mechanic 6). Auto-opens on the role's home only; Skip on card one; re-openable from
    any page's info panel.
  - Verified live against the demo project on a phone viewport: pre-login language choice
    survives sign-in with `<html lang>` agreeing; a switch changes all 7 pages walked;
    af+professional resolve together; 15 pages carry the info button; no chip rows on
    first paint and filtering writes `type=tractor` as before; the tour opens/advances/
    resumes/stays-skipped/restarts and drivers get driver copy. Hydration, tap-target
    (0 under 48px, 0 icon-only), role-dispatch, support-mode suites all still pass.

- **FleetWise F14, Partner commercial suite: branded quotes, invoices & payments**
  (migrations `0380-0384`; branch `claude/fleetwise-ui-redesign-l4ng55`; isolation-tested,
  `db:test` green; verified live against the demo project):
  - Brings **TJ-AutoVault's commercial layer** onto the FleetWise spine, reshaped for how
    this product is sold. AutoVault's tenant is a workshop and its customers get their own
    login; ours is a farm, and partners reach in through `workshop_links` + RLS. So the
    documents live on the farm's side of the fence and are scoped to the issuing partner.
  - **`0380` partner business profile** on `workshops` (not a parallel branding table -
    a workshop already IS the partner account, so RLS/audit/grants come along): trading
    name, company reg, VAT number, address, banking, logo, two brand colours, standing
    terms + footer, numbering prefixes and per-partner counters.
    `app.next_document_number` allocates under a row lock (two staff issuing at the same
    second get 0007 and 0008); the `public.` wrapper refuses another partner's sequence.
    New `workshops_upd_self` policy lets a partner maintain its OWN letterhead, and a
    guard trigger rejects a plan change from anyone but RR, no self-upgrade.
  - **`0381` `partner_documents` + `_lines` + `partner_payments`.** ONE table with a
    `kind`, not AutoVault's separate quote/invoice pairs (which it then spent five
    migrations dragging back into step), converting a quote to an invoice is a copy, not
    a translation between schemas. Money ex-VAT integer cents; **lines roll up by
    trigger, payments roll up by trigger, status follows**, no total is ever typed.
    `source='uploaded'` is the load-bearing case: a partner on Sage/Xero/a receipt book
    attaches the finished PDF and types the total, so **they are never dependent on our
    invoicing**. **Invoice → ledger exactly once**: an issued partner invoice OWNS the
    cost for its work request and `0311` is replaced to stand down; a quote is never
    costed. Visibility (`app.partner_doc_visible`): a partner sees only what IT issued on
    farms it is linked to, **two contractors on one farm never see each other's
    pricing**, and operators see none at all.
  - **`0382` plans reshaped free/pro → portal/managed**, because partners choose between
    two different products, not two rungs. *Portal*: their customers see the fleet with
    them in it, their letterhead, their own uploaded paperwork. *Managed*: building
    quotes/invoices here, payments, cross-client analytics. Uploading stays core on every
    plan. Payments still deferred. Two Storage buckets (workshop-scoped branding,
    farm-scoped documents).
  - **`0383` a partner's DRAFT is private**, found by driving the built app: an unsent
    draft was showing in the farmer's list while the partner was still pricing it.
  - **`0384` the number allocator skips numbers already in use**, found the same way:
    pressing "Start it" failed with a raw Postgres unique-violation and created nothing
    once the counter and the rows had drifted (as they do after a restore or an import).
  - App: **/documents** (one route, two audiences, partner sees what it issued across
    every farm; farmer sees what was sent, decision-first), **/documents/[id]** (the
    document renders identically for both sides; the actions beneath differ),
    **/contractor/settings** (business profile, letterhead previewed as a document above
    the fields that change it), **/admin/partners** (RR sets the product; indicative price
    shown, display only). The **PDF engine is brandable**, partner wordmark, logo, colour,
    footer, with the letterhead **frozen onto the document at send time**, so a rebrand
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
    committing the transition**, the screen sat on its loading skeleton indefinitely,
    still stuck at 40 seconds. Measured **9 stuck out of 10**.
  - It reproduced just as hard on the **pre-existing** work-request page, so this was not
    new: **every server action in the product**, every save, every status change, every
    note, could leave someone staring at a frozen screen. It is almost certainly the same
    fault as the earlier, never-established report of a same-route `router.push` that
    appeared not to navigate.
  - Cause: `RouteProgress` (root layout) called `useSearchParams()` to notice a query-only
    navigation. Server actions redirect to the same path with a new query (`?saved=1`,
    `?added=1`, `?error=…`), exactly the case that subscription governs. The layout
    ALREADY wrapped it in `<Suspense>`, the documented remedy, and it froze anyway
    (re-measured: still 1 in 4). Ruled out by measurement first: the service worker
    (A/B, no change), `loading.tsx` (removed, no change), and the server itself (RSC
    payloads fetched directly, complete and fast).
  - Fix: drop the subscription. Completion now comes from `usePathname()` plus an 8-second
    hard stop. A query-only navigation rides the hard stop rather than finishing on
    arrival, deliberate: the obvious improvement (sampling `window.location.href` from
    the tick) was built and measured and **brought the freeze straight back, 4 of 4**,
    because setting state in a root-layout component while the transition is committing is
    the same class of mistake. **0 stuck in 12** afterwards, on new and pre-existing pages
    alike.

- **FleetWise F15, Offline that tells the truth, a sidebar that hides nothing, and the
  partner's own client book** (migrations `0390-0391`; isolation-tested, `db:test` green;
  verified live against the demo project):
  - **Offline was lying.** `sw.js`'s `APP_FALLBACKS` applied to EVERY uncached navigation,
    so tapping Reports with no signal silently rendered the DASHBOARD while the address
    bar still said `/reports`, someone reads the dashboard's numbers believing they are
    looking at reports. Fallbacks now apply only to a cold LAUNCH (`/`, `/home`), which
    are dispatchers with no screen of their own; anything else uncached says so.
    Additionally the app now **pre-warms the routes this ROLE can reach**
    (`WarmRoutes` → `sw.js` `warm` message), so a driver warms the driver's screens and an
    owner theirs, instead of "whatever you happened to visit". Cache version → `v3`.
    Measured live: 12+ pages cached without visiting them; machines/faults/jobcards each
    render themselves offline; an uncached page shows the offline notice, not the dashboard.
  - **Sidebar**: the "Everything else" `<details>` hid parts, partners, checklists, fines,
    settings, admin and install behind a summary, invisible to anyone who never found it.
    Now a named group like any other, inside a new **`ScrollArea`**: measured edge fades
    (only when there is genuinely more), a visible thin scrollbar rather than the overlay
    one, and a keyboard-reachable `role="region"`. **17 nav items on screen for an owner,
    0 disclosures.**
  - **`0390` partner client book**, the first tables scoped to a WORKSHOP rather than a
    farm. `partner_clients` (the partner's own customer record) + `partner_client_vehicles`
    (a mechanic's notebook: make/model/reg, free text, before the customer is on FleetWise).
    **A client row carries no authority**: setting `farm_id` on one does NOT grant access -
    that still comes solely from an ACTIVE `workshop_link`, and `app.has_farm_access` is
    untouched. Proven: the F15 suite writes a Farm B id onto a client row as a partner with
    no link and asserts it still sees 0 of that farm's machines.
  - **The handshake, both directions.** `workshop_link_status` already had `pending` and
    `has_farm_access` counts only `active`, so a request needed no new table: 0390 adds one
    narrow policy letting a partner raise a **pending** link for its own workshop, and
    approval stays with the farm's owner/manager (`wl_upd` never covered workshops). A
    partner therefore cannot connect itself to anybody, cannot raise an ACTIVE link, and
    cannot raise one on another workshop's behalf, all asserted. The farm decides on
    `/partners` behind a confirmation that states exactly what access is granted.
  - **`0391`**, found by driving it: the request rendered as an empty row with no name,
    because `workshops_sel` (0101) let a farm read a workshop only through an ACTIVE link.
    You cannot approve a contractor you are not allowed to see. Widened to `pending`, which
    discloses the business card they are holding out, to the one farm they asked, and
    nothing else.
  - **Sync**: once linked, `syncClientVehicles` copies the notebook vehicles into the farm's
    real fleet through the RLS client (so it works because the link is active, and stops the
    moment it is revoked), records the `machine_id` each became, and `synced_at` closes the
    offer so a fleet cannot be duplicated by a second press.
  - The connect request **never tells a partner whether an address has a FleetWise account**
   , the action resolves it with the service role and says the same thing either way.
  - New `/contractor/clients` (+ detail) and a Clients nav item; contractor nav gains
    machines back. i18n EN/AF at parity (**1,937 leaf keys**) with professional-tone
    overlays. Demo seed gains three clients (linked / asked / not on FleetWise) with
    notebook vehicles, and a live pending request to the second farm. Gates green; shared
    first-load JS flat at **102 kB**.
  - **`0392` + app fixes, from automated review of the PR, all seven findings were real:**
    (1) **a contractor could read its competitors' business cards.** The `workshops_sel`
    link clause is guarded by `app.has_farm_access`, which deliberately admits a WORKSHOP
    with an active link, so any contractor on a shared farm could read every other
    contractor's name, trade, phone and email. NOT new in 0391: the pre-existing `active`
    clause had the same hole. Both closed by gating the clause on a new `app.is_farm_side()`.
    (2) **an approval bound the wrong client, or none**, it matched every unbound
    `requested` row for the workshop and set them all to the approving farm, colliding on
    `(workshop_id, farm_id)` and aborting *after* the link had gone active, with the error
    swallowed. New `partner_clients.requested_farm_id` records what each request was aimed
    at. (3) **multi-site**: the request list showed pending links for every accessible farm
    while approve wrote to `profile.farm_id`, now scoped to `currentFarmId` and the farm
    carried through the action, re-validated against `accessibleFarms()`. (4) **`synced_at`
    was set even when copies failed**, permanently hiding the retry; now only on a clean
    run, with a partial result reported as a warning. (5) **`ignoreDuplicates` hid an
    existing link** so a revoked relationship could never be reopened; the existing row is
    now read and handled by status. (6) **"add to my book"** on an already-connected farm
    created an *unlinked* record; it now carries the farm id, verified against a live active
    link. (7) **the offline cache was not partitioned by account**, Cache Storage is
    origin-wide and keyed by URL alone, so on a shared farm-office browser one person's
    cached screens could be served offline to the next; `WarmRoutes` now carries a
    `contextKey` (user + current farm) and posts `clear-data` when it changes, and warming
    always re-fetches instead of skipping on a hit. Isolation suite gains the
    competitor-card and bind-exactly-one-client assertions.

- **FleetWise F16, Partner access scope + VAT registration** (migrations `0400-0402`;
  isolation-tested, `db:test` green; verified live against the demo project):
  - **What was actually happening.** An active `workshop_link` granted
    `app.has_farm_access`, the SAME predicate the farm's own staff are judged by.
    Measured on the demo farm, one contractor could read **12 machines, 32 cost entries
    (the farm's whole spend, including other contractors' invoices), 3 budgets, 11 fuel
    draws, 50 meter readings, the 5 other contractors with their phone numbers, and all 6
    farm users with names and emails**. A farmer connecting a tyre fitter to change two
    tyres was handing over their supplier list, staff directory and financials.
  - **`0400`, access is now a per-link CHOICE by the farm, defaulting to the minimum.**
    Baseline = the vehicles this partner is actually working on (a work request or a
    document of theirs against it) plus the faults/jobs on those vehicles and the requests
    sent to them. Four grants open exactly their own slice: `see_all_vehicles`,
    `see_service_history`, `see_costs`, `see_team`. **`partners` has NO grant**, a
    contractor never reads the farm's other contractors, because that is a competitor list
    with phone numbers and no consent makes it part of fixing a tractor.
    Implemented as `app.partner_scope(farm, key)` + `app.partner_machine_visible(farm,
    machine)`, folded into the existing `app.row_visible_to_role` so nine machine-keyed
    tables narrow at once and the rule lives in one place. **Existing links tighten** -
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
    layout), the current customisation is letterhead + colours + terms + numbering +
    per-document editing; and the email layer, still the biggest gap against AutoVault.

- **FleetWise G1-G5, the commercial layer made correct** (migrations `0403-0404`,
  `0410-0423`; merged as PRs #13/#15/#16; isolation-tested, `db:test` green; every
  migration applied to the demo project and driven live):
  - **Two P1 security fixes first.** `0403` closed four side doors (a user could read
    another user's `notifications`; Storage object visibility was not farm-resolved; the
    VAT guard sorted BEFORE the totals trigger so a stale form could still issue VAT;
    `wl_upd` matched zero rows and reported success). `0404` closed a **privilege
    escalation**: any signed-in user could `update users set role='rr_admin'` on
    themselves and read every tenant, reachable in production via
    `PATCH /rest/v1/users?id=eq.<self>`. `users_scope_ck` blocked the naive shape, which
    is why it never showed on a policy read.
  - **Who a document is FOR** (`0410`): billing identity on `farms` + `partner_clients`;
    `partner_documents.farm_id` nullable + `partner_client_id`; eight `bill_to_*` columns
    seeded by trigger and then editable, so a customer who moves premises next year cannot
    silently restate last year's invoice. Three recipient kinds, a linked FleetWise farm,
    a client from the partner's own book, or a **one-time customer typed straight onto the
    document** (a walk-in job should not require filing a customer before you can bill it).
  - **Correcting a mistake**, the thing AutoVault has no answer for (its route
    hard-DELETEs invoices). Four ways to be wrong, four different answers: delete a draft;
    **void** with a reason (it should not exist); a **credit note** (`0411-0412`,
    `0415`) or a **debit note** (`0416`, `0418`) for the amount; and, the founder's
    call, correctly, **edit the document in place** (`0417`, `0419`). The old version
    prefills the form, is snapshotted into `partner_document_revisions` (document + lines)
    with a reason, the new version replaces it, and `revision` links them. The guarantee
    moved from "cannot change" to "cannot change without leaving a complete record":
    freeze triggers refuse every other route, and `0420` makes the history **append-only**
    (grants revoked + a trigger that raises, rr_admin included; measured first, DELETE
    ran silently at 0 rows, which is default-deny, not an audit trail) and refuses to
    revise a **draft**, which is the one path that could have taken versions with it.
  - **Statements** (`0413`, `0421`), because a monthly-account farmer pays off a
    statement, not invoices. `app.partner_statement` / `app.partner_ageing` in SQL so the
    screen, PDF, CSV and emailed copy cannot disagree. **All six AutoVault statement
    faults fixed**: it had no opening balance, found credits by regex over free text,
    showed payments only once fully paid, INVENTED a payment at full value when paid with
    no amount, inflated the invoice debit by its own credit notes and then counted them
    again, and put quotes on a statement of account.
  - **Refunds and write-offs** (`0422-0423`), both found by walking the standard
    financial-control checklist. A refund is a **negative payment** (sign enforced by
    constraint; the rollup refuses refunding more than was ever paid), so a customer
    refunded a year ago stops sitting in credit for ever. A **write-off** goes through the
    same correction machinery (reason + kept version): it stays on the statement at full
    value AND posts its own credit line so the account **nets to zero**, leaves the ageing,
    stops being chased, and **stays in the farm's cost ledger**, not paying a bill does
    not undo the work. It survives payments moving underneath it (only full settlement
    reopens it), caught by the isolation suite, which found that deleting a payment row
    put a written-off invoice back into the ageing.
  - **Email** (`0414`, Resend via a thin fetch, env-gated on `RESEND_API_KEY`/`EMAIL_FROM`):
    documents and statements go out as branded PDFs; every attempt logged, failures
    included, because a bounce nobody sees leaves the partner believing the customer was
    told. Plus a **customer-facing `/d/[token]` link** (zero anon DB), quote **expiry**,
    and overdue/expiring **reminders** on the nightly cron.
  - App: `/statements` (customer picker, period, ageing, send), `/documents/corrections`
    (every change ever made to a document that had already gone out), revise + version
    history + credit/debit/void/write-off/refund on the document page, and the statement's
    row wording moved **out of SQL into `lib/statement.ts`**, a statement posted to an
    Afrikaans farm was having half its lines written in English by a Postgres function.
  - `rls_isolation.sql` gains **G2-G5**. i18n EN/AF at parity (**2,211 leaf keys**).
    Gates green; shared first-load JS flat at **102 kB**.
  - **Known gaps, in order of who is blocked**: no **VAT-return (output VAT) report** for
    a period, a real blocker for a VAT-registered partner at filing time; no
    purchase/expense side (this is sales-only); no deposits, progress/milestone billing,
    recurring invoices, or online payment; no document **template builder** (customisation
    is letterhead + colours + terms + numbering + per-document editing).

- **FleetWise G6-G10, the financial manager completed** (migrations `0430-0435`;
  isolation-tested, `db:test` green; every migration applied to the demo project and
  driven live):
  - **The purchase side** (`0430`). Everything before this was SALES. `partner_expenses`
   , supplier, their invoice number and date, category, ex-VAT cents with the supplier's
    OWN VAT amount captured alongside (a source document's VAT line is what may legally be
    claimed), and a `vat_claimable` flag for the VAT Act s17(2) blocks (entertainment,
    passenger vehicles, club fees). WORKSHOP-scoped like the client book: a farm reading
    what its contractor pays its suppliers would hand over their margin on every job.
    Capture form is a client component solely so the inclusive split shows live -
    R1 150,00 off a till slip becomes "R1 000,00 + R150,00" before you press anything.
  - **VAT return** (`0431`), the gap most likely to send a partner back to a spreadsheet.
    `app.partner_vat_return`: output VAT (invoices + debit notes adding, credit notes
    subtracting, drafts/voids absent) less input VAT, on the **INVOICE BASIS** (time of
    supply = issue date, s9(1)) with that said in words on the screen. Real SARS **VAT
    periods** offered rather than a free range (`workshops.vat_category` A/B/monthly), because
    the wrong pair double-counts one month and omits another. A **written-off** invoice
    still declared its VAT, s22 bad-debt relief is a separate claim, so the return
    reports the amount and points at it rather than quietly making it. Screen + CSV (with
    every document and expense behind the figure) + PDF on the letterhead.
  - **Deposits and progress billing** (`0432`), one mechanism, because a deposit and a
    progress payment are the same act to a ledger: an invoice for PART of an agreed job.
    Many invoices may point at one quote; `app.quote_billing` keeps it honest. Each stage
    carries its OWN lines and its own cost entry, **no netting, no deduction field**, so
    three invoices of R5 000 against a R15 000 quote put exactly R15 000 into the farm's
    ledger (asserted). Over-billing is flagged, not refused: jobs grow.
  - **Standing invoices** (`0433`), the failure is forgetting, not mis-billing. Cadence +
    next date + lines; the nightly cron raises real documents. Generates a **DRAFT** by
    default (`auto_send` off), and **cannot run twice for the same period**
    (`last_period_start` is the idempotency key, a double-fired cron, a retry, and the
    partner's "raise it now" all go through it). Month arithmetic in its own function on
    both sides, checked against Postgres on 12 cases incl. leap years.
  - **Document layout** (`0434`), not a designer: a closed set of choices (what things are
    CALLED, which blocks appear, density, accent style) applied identically by screen and
    PDF, with a DB trigger refusing unknown keys and a live miniature preview. A
    VAT-registered partner's invoice defaults to **"Tax invoice"** because s20(4) requires
    it to be headed as one. Frozen into `issuer_snapshot` with the letterhead.
  - **Online payment** (`0435`, PayFast, env-gated), signature computed SERVER-side,
    checkout POSTed as a form (never a signed query string), and the callback believed only
    when the signature recomputes, the amount matches OUR record, and PayFast confirms the
    payload. A retried callback cannot credit twice: unique index on
    `(provider, provider_ref)`, not a check in the route. Signature verified against
    PayFast's own worked example, byte for byte. **The ITN itself is untested**, it needs
    live credentials and a real payment.
  - **A defect the browser found**: `toLocaleString("en-ZA")` gives "2 242,50" in Node and
    "2,242.50" in Chrome (trimmed ICU falls back to en-US). Every server-rendered amount
    and every client-rendered one disagreed, and any client component showing money
    hydrated with different text, React #418, which throws the server HTML away. `rands`
    and `num` are now written out by hand; verified on 18 cases and re-measured in the
    browser.
  - Also fixed this session: **every ConfirmDialog in the product was unreachable by
    keyboard** (the focus-trap selector matched `input[type=hidden]`, so focus stayed on
    the trigger outside the portal and Escape never reached the handler); initial focus now
    lands on the first field, never the destructive button. And the write-off dialog named
    `total − paid`, ignoring credit notes already raised.
  - `rls_isolation.sql` gains **G6-G10**. i18n EN/AF at parity (**2,454 leaf keys**). Gates
    green; shared first-load JS flat at **102 kB**.
  - **Still missing**: deposits/progress/recurring/VAT/expenses/layout/payments are now
    built, so the remaining gaps are narrower, no bank-feed import or reconciliation, no
    multi-currency, no payroll, and the PayFast callback is unexercised until credentials
    exist.


- **Verification pass + G11-G13** (migrations `0440`, `0450-0452`; isolation-tested,
  `db:test` green; everything below applied to the demo project and driven live):
  - **A debugging helper on the live database let anyone read as anyone.** Fingerprinting
    every object the migrations create against the hosted project found exactly one object
    on production and nowhere in the repo: `public._f14_probe(uuid)`, left from F14. It did
    NOT bypass RLS, `SECURITY INVOKER`, but its body called
    `set_config('request.jwt.claims', …)` with a uuid **the caller chooses**, and every
    policy decides through `auth.uid()`. So it moved the caller to the other side of the
    fence and let RLS answer correctly for somebody else, which is the more dangerous shape
    because every policy still "passes". Measured before removal: a Weltevrede operator
    (0 partner documents of their own) read back a contractor's 5/10/1 and the platform
    admin's 6/12/1. `anon` could execute it too, a function with no grant defaults to
    `EXECUTE TO PUBLIC`, and was stopped only by this schema's table grants.
    `0440` drops it and revokes that PUBLIC default from eleven `app.*` helpers that still
    carried it (**not** reachable, PostgREST exposes only `public`/`graphql_public` and
    answers PGRST106 for `app`, so recorded as defence in depth, not a live hole).
  - **`db:test` could never have caught it**: it builds a database FROM the migrations, so
    a production-only object is invisible. Three things change that: a **G11** suite
    section (nothing outside the test harness may rewrite `request.jwt.claims`; `_f14_probe`
    named explicitly; anon executes nothing in `app`), and
    **`scripts/schema_fingerprint.sql` + `docs/SCHEMA_DRIFT.md`**, one line per object
    across ten categories **including function grants**, which a body-only diff misses.
    G11 immediately earned itself by catching `app.stock_needs_reorder` with the same
    PUBLIC default, the first time the suite ran after it was added.
  - **Repo vs production is now provably identical**: 981 objects, 10 categories, all
    matching. The handover's fear of column/policy drift was unfounded, what looked like
    33 differing functions was three artifacts of a Windows checkout (CRLF in function
    bodies, a psql client-encoding mismatch turning em-dashes to mojibake, and production
    having comments stripped by how migrations were pasted). All three are documented in
    `SCHEMA_DRIFT.md` because they will catch the next person too.
  - **Two dead ends found by driving the screens, not reading them.** `vatPeriods` returns
    closed periods only, so an expense captured today fell in a period the screen refused
    to offer and `/vat` said "you have not captured anything you bought in this period" -
    which reads as "the capture failed". `currentVatPeriod` adds the open period, marked
    "still open", never the default. And `/recurring` said "you can raise one now" with no
    control to do it (it lives on the schedule's own page); the copy now says to open one
    and each due row carries the cue, as a `<span>`, because the row is already an anchor
    and a nested anchor is the invalid HTML that threw React #418 on the machines list.
  - **§4 of the handover, worked through**: `/expenses`, `/vat`, `/recurring`,
    `/contractor/settings` and progress billing all driven end-to-end with real writes.
    Proven live: a standing invoice pressed twice raises exactly ONE document
    (217 391 + 32 609 = 250 000 exactly); a 25% stage invoice books 103 250, its own value,
    not the quote's, and a quote is never costed; a **sent** document keeps the letterhead
    frozen at send time while a **draft** picks up a newly saved layout; both PDFs generate.
    All ten nightly cron engines run clean against the live database (the HTTP route itself
    still needs `SUPABASE_SERVICE_ROLE_KEY` + `CRON_SECRET` in Vercel).
  - **§3 re-verified independently**: `rands()` renders identically in Node and Chrome
    across 22 cases; `advanceByCadence` agrees with `app.advance_by_cadence` on 12 cases
    including leap years; VAT periods have no gaps, no overlaps, correct category parity and
    real month-ends; PayFast's three signing behaviours (order preserved, PHP `urlencode`,
    empty fields omitted) all hold.
  - **Receipts for expenses (§4.6)**, the bucket, its policies and `receipt_path` existed
    since 0430; only the way to put a file there was missing, so a VAT-registered partner's
    every input-VAT claim was unsupported. Founder's call: **warn, never block**, the
    expense always saves, and the gap shows as an amount at the top of `/expenses`, a flag
    on the row, and a line on the VAT return before it is filed. Uploads go through the
    CALLER'S RLS client (the 0430 policies already scope the bucket by workshop), so no
    service key is involved. Measured live: signing TJ's receipt returns 200 for TJ and
    **400** for another contractor, for the farm TJ works for, and for anon. **G12** asserts
    the column and the write; the storage policies are not testable locally (0430 skips them
    where there is no `storage` schema) and that is said in the section.
  - **Stock on hand (§6 inventory; `0450-0452`)**, `parts_catalogue` was a list and could
    not answer "have we got one?". Shape is **F4's fuel model with different nouns**:
    `stock_items` + a `stock_movements` ledger, `on_hand` maintained by trigger and never
    typed. The money rule, chosen by the founder and asserted **both ways**: a receipt books
    nothing; an issue **naming a job card** books nothing (the 0211 line owns that rand -
    the no-double-count rule); an issue **with no job card** books a `parts` cost entry
    against the machine; adjustments and returns book nothing. Live: received 10 at R112 →
    no cost; issued 2 to the Claas Stroper → one entry of exactly 22 400. Contractors read
    0 items and 0 movements despite an active link. `0452` closes a gap the browser found:
    the policies admitted an **operator** to write while the server actions did not, UI-only
    enforcement, which F7 exists to rule out. Reading stays open to the whole farm side
    (a driver may ask "have we got a filter?"); the write narrows to owner/manager/mechanic.
    `0451` adds a low-stock nudge on the 0205 engine pattern, wired into the nightly cron.
  - i18n EN/AF at parity (**2 501 leaf keys**). Gates green; shared first-load JS flat at
    **102 kB**.
  - **Still not verifiable here** (all need secrets held by the founder): email has never
    sent (`RESEND_API_KEY`/`EMAIL_FROM`), the PayFast ITN round trip needs merchant
    credentials, and the cron HTTP route needs the service-role key. The PayFast signature
    was checked behaviourally rather than against PayFast's published worked example.

- **Money answers, P&L, debtors, creditors, cash** (migration `0460`; isolation-tested,
  `db:test` green; driven live). The commercial layer recorded transactions well and
  reported on them barely at all: verified before building, there was no P&L anywhere in
  the codebase, and `app.partner_ageing` **required** a farm or a client, so "who owes me
  across everyone" matched nothing. Turnover was visible; profit was not.
  `/money` adds profit for a period with a category breakdown, cash in/out, and both
  ageing lists. **No new tables**, every figure aggregates `partner_documents`,
  `partner_payments` and `partner_expenses`. All five functions are SECURITY INVOKER, so
  passing another workshop's id is answered by RLS on the underlying tables rather than by
  a check somebody could forget to write; a rival workshop and the farm they work for both
  read zeros.
  Three judgements, each a place a plausible implementation would be wrong, each pinned in
  **G14**: a **written-off invoice stays revenue** and comes off again as bad debt
  (dropping it would quietly restate a period already filed with SARS); **non-claimable
  VAT is a cost** even though SARS will not refund it, omitting it overstates profit by
  exactly the amount most likely to be forgotten; and a written-off invoice must **not**
  still be chased on the debtors list. Creditor ageing buckets from the supplier's own
  invoice date, because an expense carries no due date, and the screen says so rather than
  implying lateness.
  G14 also asserts the P&L's revenue equals the VAT return's over the same window, the
  two screens are read by the same person in the same week, and if they disagree both are
  useless. Live: August showed R582,50 invoiced against R1 000,00 of costs (a real loss),
  while `/vat` independently showed R1 032,50 of sales less R450,00 of credit notes, the
  same R582,50. Periods are **calendar**, not the SARS two-month cycle, because "did last
  month make money" is a calendar question; this month is offered though incomplete, for
  the same reason `currentVatPeriod` exists. i18n EN/AF at parity (**2 539 leaf keys**).

- **Wave 1 of the business/financial tranche, bank reconciliation, purchase orders,
  quote conversion** (migrations `0470-0476`; isolation-tested, `db:test` green; all six
  applied to the demo project and driven live). Built by three subagents in parallel with
  strict file ownership, the orchestrator kept `rls_isolation.sql`, both dictionaries,
  `layout.tsx` and the cron route, and agents delivered assertions/i18n/nav as separate
  fragments into `pending/` for merging. **No payment processing**: customers pay by EFT
  outside the product and invoices already carry banking details, so PayFast (`0435`)
  stays env-gated and inert.
  - **Bank reconciliation (`0470-0472`, G15).** Import a bank CSV with column mapping,
    match money-in against unpaid invoices and money-out against unpaid supplier invoices,
    confirm behind a dialog that states the consequence. Re-importing the same statement is
    a no-op, enforced by a unique index on
    `(workshop, date, amount, fingerprint, occurrence)` rather than application logic -
    `fingerprint` is a GENERATED column so the key cannot drift with the client, and
    `occurrence` stops the key being wrong when a business is genuinely charged the same
    R50 twice in a day. Confirming inserts a `partner_payments` row and NOTHING else: the
    document's paid amount and status move through the existing 0381 rollup, so there is
    one path to a balance, not two. `bank_lines.status` is itself a rollup (`0472`), not
    typed at confirm time, because a payment reversed on the document page would otherwise
    leave a line still claiming to be reconciled. Settlement indexes are partial on
    `deleted_at is null` as well: undo soft-deletes the payment, and without that a partner
    who undid a match to fix a date could never confirm that line again.
  - **Purchase orders (`0473-0475`, G16).** Header + lines, totals maintained by trigger,
    status derived from what has arrived (per-line clamped, so over-delivery on one line
    cannot mask a shortfall on another). **A purchase order is a commitment, not a cost**:
    `0473`/`0474` contain no code path to `cost_entries` or `partner_expenses` at all -
    verified by reading, not by trusting the agent's report. The cost appears once, when
    the supplier invoice is captured, and a partial unique index makes a second live
    conversion impossible. G16 asserts both directions against a ledger snapshot taken
    before any order exists, because the direction that catches a double-count is the one
    proving the cost is NOT there yet.
  - **Quote conversion (`0476`, G17).** "Converted" is deliberately not `status =
    'accepted'`: customers phone, say yes, and the partner goes straight to invoicing, so
    an ISSUED invoice against a quote counts, while a DRAFT one does not, since a
    partner's own unsent paperwork must not inflate their rate. Expiry likewise reads the
    date, not the status, because `app.expire_partner_quotes` runs on a cron that has never
    fired in production. Two rates are reported because neither is honest alone. Live on
    the demo project: TJ shows 1 of 2 converted, and the converted one is `TJQ-0001`, whose
    status is still `sent`.
  - **What was checked rather than accepted.** Both agents reported success; the deciding
    claims were re-run: all migrations apply to a fresh database; G15/G16 pass inside the
    FULL suite, not only the agents' private ones; the no-cost claim by grep; i18n through
    a merge tool that refuses a fragment breaking parity, overwriting a key, or shipping
    Afrikaans identical to English. Both agents independently chose the `inbox` icon, a
    collision a workshop would see, so banking took `download`.
  - **Driven live afterwards**, which settled the one thing the bank agent could not test:
    `supabase-js` upsert with `ignoreDuplicates` against a GENERATED column in the conflict
    target works over PostgREST (second identical import inserted 0 rows). Confirming a
    match moved `TJI-0001` from `part_paid` to `paid` (350 750 of 350 750) **through the
    existing trigger**, set the supplier expense's `paid_on` to the date money left, and
    booked zero cost entries. Two "no match" results were investigated and found CORRECT:
    the matcher skips fully-paid invoices and refuses a payment dated more than a week
    before its invoice existed. Nine partner routes: no overflow, no nested anchors, no raw
    i18n keys, no JS errors.
  - i18n EN/AF at parity (**2 896 leaf keys**). Gates green; shared first-load JS flat at
    **102 kB**.
  - **A voice-assistant workstream ran concurrently in the same tree** and is entangled
    with this work in three files (`layout.tsx` imports one of its components, the suite
    references its tables 29 times, the dictionaries interleave its keys), so the two were
    committed together on the founder's instruction. **Its migrations are NOT fully applied
    to production**: only the four `users.ai_processing_*` columns were applied here,
    because `PROFILE_COLUMNS` selects them and `requireProfile()` gates every page, without
    them every role was bounced to `/login?error=no-profile`, a total outage. `voice_captures`,
    `ai_interactions`, `asset_aliases` and their policies remain outstanding: known drift,
    to be applied by whoever owns that workstream.

- **Wave 2 of the business/financial tranche, suppliers as records, recurring expenses,
  cash-flow forecast** (migrations `0480-0483`, `0486`; isolation-tested, `db:test` green;
  all five applied to the demo project and driven live). Built by three subagents in
  parallel under the same ownership discipline as wave 1, with one addition that removed
  the only real dependency between them: the supplier work adds a trigger that resolves
  free-text `supplier_name` to a record, so the recurring-expense work never had to know
  suppliers existed.
  - **Suppliers (`0480-0482`, G18).** `partner_expenses.supplier_name` was free text and
    `app.partner_creditors` grouped the payables ageing by `btrim()` of it, so "Agri
    Diesel" and "agri diesel " were two businesses owed money; purchase orders had just
    inherited the same weakness. A workshop-scoped `suppliers` table (a farm reading its
    contractor's supplier list and terms would be reading the margin behind every quote it
    is given), `supplier_id` on expenses AND orders with composite FKs, and a BEFORE
    trigger that links by trimmed case-insensitive name and **never creates**, a typo must
    not mint a supplier. Editing a name away from its record drops the link rather than
    leaving a row printing one business and ageing under another. The trigger is
    deliberately NOT `SECURITY DEFINER`, so the lookup runs under the caller's own RLS.
    `partner_creditors` now groups by the RECORD where one is linked and by the lower-cased
    trimmed name where none is, so the split is fixed even for a business nobody has filed;
    same columns and buckets, because `/money` renders it. **Proven on production**: the
    backfill filed Agri Diesel Depot and linked it; inserting `'  agri diesel depot '` -
    different case AND whitespace, linked to the same record and the ageing returned ONE
    creditor. The agent also found a bug in its own scope: `updateExpense`'s `"-"` fallback
    minted a nameless permanent creditor.
  - **Recurring expenses (`0483`, G19).** The cost-side mirror of `0433`, wired into the
    nightly cron. Its reasoning goes one step past the sales side: `last_period_start` makes
    a SEQUENCE of runs idempotent and a `for update` row lock handles two CONCURRENT ones -
    different problems. Header only, no lines: a `partner_expense` is a single amount by
    0430's design, so a lines table would hold one row for ever and put the amount in two
    places that can disagree. Generated rows are ordinary expenses, asserted by checking
    they land in `app.partner_pl`'s cost. `run_recurring_expense` checks ownership itself
    because the generator it calls is `SECURITY DEFINER` and would otherwise trust any id.
  - **Cash flow (`0486`, G20).** `/money` says what happened; nothing said what is about to.
    Five buckets from overdue to later with a running total, over outstanding invoices,
    standing invoices not yet raised, unpaid supplier bills and open purchase orders. The
    aggregate is built FROM the item list rather than repeating its four queries, so a
    bucket total cannot disagree with the rows beneath it. A purchase order already
    converted to an expense is excluded, otherwise it counts once as a commitment and again
    as a bill. All GROSS, said in the header, in the lib and on the screen, because a
    forecast is about cash leaving the bank. Supplier terms default to 30 days from the
    supplier's own invoice date and the screen says so in words: `partner_expenses` has no
    due date, so a forecast must assume one, and between two wrong answers the earlier one
    fails safe.
  - Also closed the two gaps the wave-1 audit found: the purchase-order badge now lives in
    `components/ui/status.tsx` beside the other ten, and an expense converted from an order
    links back to it.
  - **What the agents caught that the brief got wrong.** One was told to use fixture ids
    starting `6g`; `g` is not a hex digit and `uuid` rejects it, it used `70` and said so.
    Another's own "the farm reads nothing" assertion FAILED, and rather than delete it, it
    established that a farm DOES read its own invoices through these functions by design,
    confirmed no margin leak (expenses, orders, standing income and the whole `out_cents`
    column return zero), and pinned that exact shape so nobody later "fixes" it by writing a
    workshop check into a function body.
  - **Driven live afterwards**: all three screens render against production with no
    overflow, no nested anchors, no raw i18n keys and no JS errors; the forecast's single
    movement was reconciled against `partner_debtors`/`partner_creditors` (both genuinely
    empty after the bank reconciliation) rather than assumed; all six partner money screens
    appear in the nav in a sensible order; and a farm owner opening `/cashflow` directly
    lands on `/dashboard`, refused by the guard, not merely hidden in the nav.
  - 48 suite banners. i18n EN/AF at parity (**3 075 leaf keys**). Gates green; shared
    first-load JS flat at **102 kB**.

- **Two settings the product asked for and then ignored, and a third partner product**
  (migrations `0490-0492`; isolation-tested, `db:test` green; all three applied to the
  demo project and driven live):
  - Auditing the financial layer against a standard SMB system found two settings that
    were captured, stored and then not honoured, the worst of the three possible states,
    because an absent setting is obvious and a wrong one is visible, while a setting the
    product asks for and ignores buys trust its output has not earned.
    **`0490`**: `vat_registered` guarded the SALES side since 0401, but nothing guarded
    the PURCHASE side, so a business not registered for VAT could capture a supplier
    invoice with `vat_claimable` ticked (the default) and have `app.partner_pl` treat the
    ex-VAT figure as the cost. Measured on exactly that input before the fix: cost 100000,
    blocked 0, against R1 150 that genuinely left the bank, profit overstated by the VAT
    on **every purchase the business makes**. A BEFORE trigger on `partner_expenses` and
    `recurring_expenses` now forces the flag false for an unregistered issuer (an UPDATE
    cannot smuggle it back), and the capture forms stop offering a choice that has one
    answer. Registering later frees the next capture without rewriting history.
    **`0491`**: `suppliers.payment_terms_days` was asked for on `/suppliers` and then
    ignored by the forecast, which assumed 30 days for everyone, so a partner could file
    "60 days" and read a cash-flow that spent the money in 30. Now
    `coalesce(supplier.payment_terms_days, 30)`, with the fallback still stated in words
    for a supplier nobody has filed. **G21** pins both, including the direction that
    catches a blanket refusal (a REGISTERED business must be untouched).
  - **`0492`, a third partner product, `books`.** 0382 shaped the partner offer as two
    products rather than two sizes; since then a whole financial-management layer has
    grown above it, and that is not a bigger version of invoicing, it is the difference
    between writing the invoice and knowing whether the month made money. `books` sits
    above `managed` and unlocks exactly the **purchase and accounting half**: `/money`,
    `/cashflow`, `/vat`, `/expenses`, `/recurring-expenses`, `/suppliers`, `/orders`,
    `/banking`. The **sales** half (documents, statements, standing invoices, corrections)
    stays on `managed` where it was, the tier is an upgrade, never a repossession, which
    is the same promise 0382 made when it kept uploading-your-own-paperwork free forever.
    One feature key (`financials`) rather than nine, because a partner does not buy "the
    VAT screen".
  - **Gated at the route AND the action**, per the F5 rule: 8 pages return a server-
    rendered `UpgradeNotice` before any query runs, **all 30 exported server actions** in
    the five actions files call the new `requireWorkshopEntitlement`, and the two VAT API
    routes answer **403** rather than redirecting (a 302 to HTML hands the caller a "CSV"
    full of markup). `UpgradeNotice` widened to take either plan family, the two label
    sets are disjoint, so the naming scheme is decided by the value, and its CTA now sends
    a partner to `/contractor` instead of a farm's vehicle list.
  - **Pricing deliberately unset**: `WORKSHOP_PLAN_PRICE_MONTHLY` is `number | null` with
    all three null, and the admin console renders a **dash** and says why. A wrong price
    shown to the person who sells the product is worse than no price, because it gets
    quoted. Nothing charges anyone, the billing adapter is still the no-op.
  - **`rls_isolation.sql` G22** proves the *opposite* of the usual entitlement test, because
    the partner plan must never become a tenancy control: the rung exists, the default did
    not move, **no row was promoted by the migration**, a partner cannot promote **itself**
    (asserted separately, a guard written as an equality against one label would pass the
    existing F14 test), buying the top product changes **nothing** about what a partner can
    SEE (and neither does a downgrade), and **no SQL mirror** of the map exists, named
    explicitly so the decision is refused rather than merely undocumented.
  - **Two ways this session's own tests were nearly worthless, both caught by measuring.**
    The G22 visibility blocks originally ran without `set role authenticated`, so they
    compared 48 raw rows to 48 raw rows with RLS bypassed, now they run as the role and
    **refuse to pass with a zero baseline**. And the live action test first reported "no
    row created", which is exactly what a button that never submitted also produces; re-run
    with the network traced, it shows **1 POST → HTTP 303 → `?error=upgrade_required`**,
    the notice rendered, the form gone and zero rows written.
  - **Driven live** against the demo project as two partners: TJ (`books`) gets all 8
    screens and 8/8 nav items; Volt (`portal`) gets the upgrade notice on all 8 URLs,
    0/8 nav items, `403` on both VAT routes, and keeps documents/statements/contractor
    throughout. The lapsed-subscription case, form opened while entitled, tier revoked
    underneath it, Save pressed, is refused at the action. Demo partner set to `books`;
    nothing else moved, and no demo data was written beyond the plan changes.
  - i18n EN/AF at parity (**3 080 leaf keys**). 50 suite banners. Gates green; shared
    first-load JS flat at **102 kB**.

- **Production brought level with the repo** (no new migration in the repo; two existing
  ones applied, one function re-stated):
  - **The voice-assistant drift is closed.** Its two dated migrations
    (`20260813195653_voice_assistant_foundation`, `20260813200621_voice_assistant_commands`)
    had been in the repo and green under `db:test` for two waves while only the four
    `users.ai_processing_*` columns were on production, so the deployed `/assistant` was
    code pointed at tables that did not exist. Both are now applied. The constraint I had
    hand-added during that earlier outage was **dropped first** so the migration file
    recreates it (verified byte-equivalent beforehand): production's schema should come from
    the repo, not from an emergency edit.
  - **Measured, not assumed**, because the commands migration rewrites `app.row_visible_to_role`
    AND the core `machines_sel` policy, the most tenancy-sensitive objects in the product.
    Counts taken before and after are identical: contractor TJ **4 machines / 0 costs / 1
    user / 3 own requests**, farm owner **15 / 38 / 6**. The operator rule was then exercised
    on a driver who actually has an assignment: **1 machine of 15, the assigned one**. Worth
    recording: production has **zero `user_farm_memberships` rows**, so it is the migration's
    documented primary-farm fallback in `app.effective_farm_role` that resolves a role there,
    not a membership.
  - **Repo == production, proven across 1,256 objects in all ten fingerprint categories.**
    The first pass disagreed on two: `function` and `function-grant`, 162 local vs 157 live.
    Five of those are helpers `rls_isolation.sql` creates in the TEST database (`_t_login`,
    `_t_assert`, `_t_notif`, `_h2_fault_args`, `_h2_reading_args`) and must never exist on
    production. Excluding them, grants matched exactly and **one body** did not.
  - **Found by bisecting, not by transcribing**: digest by schema (`public` matched, `app`
    did not), then by `left(proname,1)` (16 of 17 buckets matched) → `app.partner_creditors`.
    Production held a logically identical body whose only real difference was **one
    character**, the nameless-creditor fallback label was `'-'` where the repo has `'-'`,
    from an earlier session loading `0482` through psql without `PGCLIENTENCODING=UTF8`.
    Cosmetic, but the fingerprint deliberately does not normalise a string literal, so it was
    corrected rather than explained away. `docs/SCHEMA_DRIFT.md` now carries the instance and
    the bisect technique.
  - **Nothing exists on production that is absent from the repo**, the `_f14_probe` direction,
    the one that matters.
  - Git was already clean and in sync; the only content anywhere on GitHub but not on `main`
    was one orphaned docs file on the ancient `week-1-foundation` branch, now brought across.
    The `fleetwise-financial-controls` branch is fully contained in `main` (squash-merged,
    content verified identical) and is stale, not pending.


- **Wave 3, supplier statements, commitment-aware reordering, document templates, and a
  statement bug the arithmetic hid** (migrations `0502-0505`; isolation-tested, `db:test`
  green at **56 sections**; built by three subagents in parallel under the wave-1 ownership
  discipline, every deciding claim re-run by the orchestrator before acceptance):
  - **Supplier statements + remittance (`0502`, G25).** `/money` could say "you owe Bolt &
    Bearing R805,00" since 0460/0482 and there was no way to open that line. `app.supplier_statement`
    / `app.supplier_ageing` / `app.supplier_remittance`, all `security invoker` so RLS answers
    rather than a check someone could forget. No new tables, everything aggregates
    `partner_expenses` (0430) and `suppliers` (0480). **Workshop-scoped**: a farm reading what
    its contractor pays its suppliers would be reading the margin behind every quote it is
    given, and G25 proves the rival and the farm both read 0 while the partner reads 12 lines.
    The ordering uses an **explicit rank**, deliberately not copying 0413's, which is how the
    0504 bug below was found. The limitation is written into the migration header rather than
    papered over: the purchase side has no payment ROWS, only `partner_expenses.paid_on`, so a
    part-payment to a supplier cannot be represented and a "payment" line is a bill whose
    `paid_on` falls in the period, credited at full gross.
  - **`0504`, the balance brought forward was not always the first line.** Found while
    building the supplier statement. `app.partner_statement` ended `order by 1, 2` from 0413,
    carried through 0418 and 0423; the opening row is dated `p_from`, and `credit_note`,
    `debit_note` and `invoice` all sort BEFORE `opening`. So any document issued on the
    window's first day, the 1st of a month, or exactly 90 days ago, which is the DEFAULT
    period, printed above "Balance brought forward", and `withRunningBalance` ran the Balance
    column from the wrong start for every row above it. **Reproduced before the fix**: an
    invoice of R230,00 rendered as line 1 with a running balance of R230,00 when the customer
    owed R1 150,00. The closing total was always right, which is exactly why it survived four
    migrations and a live click-through, every subtotal reconciled. A rank cannot be
    expressed in the ORDER BY of a UNION (Postgres allows only output column names or ordinal
    positions), so the union moves into a subquery; the tie-break after the rank is still
    `kind`, and nothing else changed. Affects `/statements`, the statement PDF, the CSV and
    the emailed copy. **G28 mutation-tested**: reinstalling the 0423 ordering makes assertion
    (a) fire naming the defect; restoring 0504 makes it pass.
  - **Commitment-aware reordering (`0503`, G26).** Not 0451's "you have 2 and your minimum is
    3", but "the services due in the next 30 days need 9 filters and you have 4", joining
    `service_kit_items` (0271), the 0202 due engine and `stock_items` (0450). Lookahead is a
    farm setting (`reorder_lookahead_days`, default 30, clamped 1-365) written through the
    existing `update_farm_settings` RPC, so no schema or policy change. Meter projection uses
    the **observed** trailing-90-day rate, not G1's utilisation capacity, at 10 h/day every
    250 h service would be "due within 30 days" for ever. 0451's engine is **replaced, not
    duplicated**, and skips any item the shortfall engine will speak about, so a shelf raises
    one sentence a week whichever engine runs first; G26 asserts both directions. Warn, never
    block: no trigger, no constraint. Wired into the nightly cron as step 11.
  - **Document templates (`0505`, G27).** Four named presets, classic / compact / plain /
    totals_only, over the **existing 0434 layout keys**, applied through 0434's own
    `update_document_layout` merge and resolved by 0434's own resolver, so screen and PDF
    cannot drift. Not a builder: nothing new can be expressed, which is the point. A template
    governs **shape only** and never the wording keys, because `invoice_title` is load-bearing
    in law, `documentTitle()` supplies "Tax invoice" for a VAT-registered partner exactly
    when that key is empty, so a template that renamed headings would silently invalidate the
    document (asserted in SQL and measured in the PDF across all four templates). The picker
    is server-rendered with zero new client JS. Not entitlement-gated, matching
    `updateDocumentLayout`, branding is core on every plan, as 0382 promised.
  - **The PDF engine rendered `density` and `accent_style` on screen and dropped them in the
    PDF**, so two of the four templates would have been half-kept in the emailed artefact.
    `PdfBrand` gains `accent` and `rowGap` (defaults identical to today). Measured off the
    page: `plain` draws only two colours on the whole sheet, `compact` is the only one with
    the accent rule and fits 17 lines before spilling against classic's 3.
  - **`Pdf.table()` neither wrapped nor clipped a cell**, it drew the text then advanced
    `x += w`, so any oversized cell silently overlapped its neighbour. Pre-existing, affecting
    every invoice, quote, statement and remittance the product has ever printed. Measured with
    pdf-lib metrics: "Front wheel bearing kit + oil seal set" is 143pt in a 130pt column, an
    utterly ordinary parts description colliding with a money column. `Pdf.fit()` now trims
    against a 5pt gutter and appends an ellipsis; **right-aligned money cells are exempt**,
    because a truncated amount reads as a smaller number, which is worse than a visible
    overlap. Fixing it exposed a second defect: `partner-document.ts` **prepended** the line-
    number column instead of taking it out of the description, running 24.7pt past the right
    margin, invisible while the default was off, which `compact` turns on.
  - **Byte-identity proved independently of the agent that made the change**: the same invoice
    rendered through the engine at HEAD and as it now stands hashes identically for a partner
    who never opened the branding screen (`layout` null, `{}`, wording-only, and the 0434
    defaults written out in full), and differs only for the long-description case that was
    already broken. That is the evidence the fix changes nothing except what was wrong.
  - **PDFs were generated, not merely compiled**, the gap the supplier-statement agent
    declared honestly. 121 statement rows paginate to 4 pages; the six-column remittance fits
    (480pt against a 499.28pt content width); an empty period renders a document rather than
    throwing; Afrikaans does not throw.
  - **What the mutation exercise bought.** The reordering agent ran 32 mutations, all caught,
    and four of them found things reading had not: its first harness passed POSIX paths to a
    Windows psql, which prints `error:` in lowercase, so a grep missed it and **all 24
    assertions were reported as "cannot fail" while nothing had run**; `select * into r` with
    no matching row leaves every field NULL and `NULL <> 4` is NULL, so three blocks would
    have passed silently if a shelf vanished from the report; and calling the function turned
    up a real 0503 defect where a shelf at −2 with nothing committed reported `short_qty = 2`
    while `is_short` was false.
  - i18n EN/AF at parity (**3 179 leaf keys**; `supplierStatement.*`, `reorder.*`,
    `docTemplate.*`, `notifications.tplStockShort`). Gates green (typecheck + lint + build +
    `db:test`); shared first-load JS flat at **102 kB**.
  - **Known gaps, unchanged or newly named**: the customer-facing `/d/[token]` page ignores
    `doc_layout` entirely, it hardcodes an accent band and calls `documentLabel(kind)`, so
    the page the person PAYING is linked to shows "Invoice", never "Tax invoice", never the
    partner's own wording, and never the layout they chose; the authenticated page and the PDF
    both honour it. The PDF also heads the recipient block "To" regardless of `bill_to_label`.
    Still no bank-feed reconciliation beyond 0470, no multi-currency, no payroll, and the
    PayFast ITN remains unexercised (deliberately, payments stay outside the product).

- **Recorded late: the voice release and `0506`-`0508`.** A release of 91 files landed
  between waves carrying the voice assistant, two dated migrations
  (`post_release_popia_coverage`, `selected_farm_administration`) and two new test files -
  `run.sh` now runs **four** suites, not one. Alongside it came **`0506` scheduled &
  emailed reports** (G29; idempotent per period, on the nightly cron, unblocked by email
  going live), **`0507` per-user permission overrides**, and **`0508` public REST API +
  QR re-issue**. None of it was in this block; it is here now so the next reader is not
  told the product stops at Wave 3. One correction it forced: the write rules on
  `user_permission_grants` are **not** `0507`'s, `selected_farm_administration` recreates
  `upg_sel/ins/upd/del` using `app.effective_farm_role(auth.uid(), farm_id)` (the caller's
  role on *that* farm) rather than their primary-farm role. A tightening. The twenty
  `_perm` policies were untouched, which is exactly what the `_perm` suffix was for.

- **Wave 4, the last of the "not built" list, and the documents that were lying**
  (migration `0510`; suite sections **G30 / G32 / G33**; **63 banners across four files**,
  green; built by three subagents under the wave-1 ownership discipline, every deciding
  claim re-run by the orchestrator):
  - **`0507` proven correct as shipped (G30).** It layers permissive policies onto
    `machines` and twelve other tables and had shipped with no assertion section at all -
    the one thing in this codebase that had never been true before. The additive claim is
    now measured rather than asserted: **63 RLS tables × 14 personas = 882 cells, zero
    differences** with no grants present, and proven non-vacuous by showing it moves -
    one `see_all_vehicles` grant changes exactly 11 cells, for exactly one person.
    **34 mutations, 32 caught**; the two that were not are a deliberate no-op control
    (proving the rig can report "not caught") and a guard that is double-enforced, where
    breaking both locks does fire. No `0511` was needed.
  - **The hole that pass found in its own test.** The first "`see_all_vehicles` must not
    leak costs" assertion **could not fail**: an operator already reads the farm's whole
    spend, because `cost_entries_sel` gates on partner scope and never on the assignment
    rule, so the cell was saturated and a mutation wiring costs into the vehicle grant
    passed unnoticed. Same trap as the G22 zero-baseline problem wearing the opposite
    disguise. Replaced with a **structural** assertion that enumerates every policy whose
    predicate mentions `app.has_permission` and compares the `table:command:permission`
    signature set, which catches any future migration wiring a grant into a table nobody
    argued for, saturated cell or not.
  - **Compliance / sale / warranty packs finished and proven (G32).** The brief was wrong:
    the UI entry points were already committed, as was `pack-data.ts`, 402 lines holding
    the authorization, which the brief never mentioned. **Eight real defects surfaced only
    by generating bytes.** `Pdf.fit()` truncates an over-wide cell, which is right for a
    fault description and wrong for a **column header**, and wrong for `Resolved 09…` -
    the fault resolution date an auditor came to see. **Afrikaans was the binding
    constraint more often than English** (`Binnekort verskuldig` 94pt against `Due soon`
    41pt), so a table sized by eye on an English screen truncates for exactly the farms
    that need the translation. Re-derived widths: 0 header truncations, 34 data
    truncations, all free-text and deliberate. 16 PDFs rendered; the machine with nothing
    on file prints `No licence on file` / `Geen lisensie op lêer nie` in words rather than
    leaving a blank an auditor reads as compliance. No migration, every record already
    existed, and G32(h) makes that machine-checkable.
  - **A contractor could have read what the farm paid.** F16 withholds the cost ledger,
    but `purchase_price_cents` and `supplier` live on the *machine row* a linked
    contractor may legitimately read, so **RLS alone does not stop a tyre fitter pulling
    a sale pack and reading the purchase price and who it was bought from.**
    `authorizeMachinePack` refuses `workshop` and `operator` at the door with a 403 before
    any query, and **G32(f) asserts the leak is real**, so if RLS ever starts hiding it the
    assertion fails loudly rather than the refusal quietly becoming unnecessary.
  - **Accounting export (FR-17.2) + audit location (FR-1.4), `0510`, G33.**
    `app.partner_journal` / `app.farm_journal`, both SECURITY INVOKER so RLS answers. The
    document selection is **copied verbatim** from `app.partner_vat_return` and
    `app.partner_pl`, that is what makes it reconcile, and four assertions keep it copied
    (revenue, cost, output VAT, input VAT). Judgements inherited rather than re-opened: a
    written-off invoice stays revenue and comes off again as bad debt ex-VAT (s22 relief
    stays a claim made knowingly); non-claimable VAT is debited to the expense account it
    sits on; quotes, drafts and voids are never journalled. **Retired and sold machines are
    INCLUDED** in the farm journal, deliberately opposite to every dashboard, because
    money spent on a tractor later sold is still money spent and an export that dropped it
    would not equal the ledger it claims to export. Asserted, because it is exactly what a
    later reader would "fix".
  - **The vendor formats could not be established, so it ships generic and says so.** Xero
    Central renders through JavaScript and returns a shell; Sage's own import pages 404 and
    its documentation says only "download the template from inside the product"; and the
    third-party importers that *do* publish a format **disagree with each other** while both
    calling it "the Xero format". So the export ships in the two shapes every import wizard
    reads, separate debit/credit columns, and one signed amount, named by shape, not by
    vendor, with a card on the screen saying why before any download button.
  - **Audit location, and the boundary stated rather than assumed.** Five nullable columns
    on `audit_log` filled from a `fleetwise.*` namespace, never `request.jwt.*`; `user_id`
    still comes from `auth.uid()`; and **no policy and no helper reads the namespace**,
    asserted structurally against `pg_policies` and `pg_proc.prosrc`. Measured directly by
    forging `fleetwise.user_id`, `role=rr_admin` and another farm's id: counts unchanged
    at 2/1/8 before and after, actor still the real caller. A finding while building it:
    `set_config(…, true)` is transaction-local and supabase-js issues one request per
    statement, so the namespace path only works for a caller owning its transaction -
    which is why `app.audit_context()` also reads PostgREST's `request.headers`, where
    `x-forwarded-for` and `user-agent` already arrive. Only geo needed help, via one header
    on the server client. **No browser GPS**: `docs/POPIA.md` §5.2 records why city is the
    coarsest granularity that still answers the question a human is asking.
  - **A mutation harness that was silently lying.** JavaScript's `String.replace` treats
    `$$` in the *replacement* as an escaped `$`, which ate one dollar of a `$$` dollar-quote,
    produced a mutant that would not parse, and, with no check on the apply exit code -
    ran the assertions against an **unmutated** database and reported a survivor. The same
    class of failure Wave 3 recorded. Fixed with a function replacer and a runner that
    reports `NOT-APPLIED` distinctly. 14 mutations, 14 caught afterwards.
  - **Observability (NFR-6), at zero bundle cost.** Speaks Sentry's ingest protocol over
    `fetch` rather than installing the SDK, because the shared first-load bundle has been
    held at 102 kB all project and most of what the SDK buys is weight a farmer pays for so
    that we can watch. `onRequestError` covers every Server Component, action and route
    handler; both client error boundaries report, including a new root `global-error.tsx`
    for when the layout itself fails; and the nightly cron's two silent swallows now report
   , a failing engine could previously stay broken for weeks, because its error went only
    into a JSON response body that Vercel's scheduler reads and nobody else does. 15
    assertions across three DSN configurations. Opaque uuids only; query strings dropped,
    because this codebase has put a login credential in one before.
  - **Both customer-facing document defects fixed.** `/d/[token]`, the page a customer is
    linked to, called `documentLabel(kind)` and hardcoded an accent band, so the one
    surface the PAYING party reads was the only one ignoring the partner's wording, their
    chosen template, and the fact that a VAT-registered partner's invoice must be headed
    **"Tax invoice"** (VAT Act s20(4)). And the PDF headed the recipient block "To"
    regardless of `bill_to_label`.
  - **`0501` was applied to production in pieces.** Found by diffing the `app` schema
    function-for-function: 79 local, 78 live. Its indexes and its `partner_cashflow_items`
    restatement had landed; its two `purchase_order_invoiced` functions had not. Nothing
    calls them yet, so there was no runtime impact, applied anyway, because the property
    being defended is "repo == production" and its value is that it is unconditional.
    `docs/SCHEMA_DRIFT.md` gains it as its own class: **count objects, not migrations**, a
    ledger would have shown `0501` as done while four fifths of it was.
  - **The documents were audited against the code, and most of them were wrong.**
    `FLEETWISE_STATUS_CHECKLIST.md` marked **27 items not started; 18 were shipped** -
    multi-site, per-role visibility, service kits, the parts catalogue, stock, budgets,
    repair-vs-replace, utilisation, Excel export, the AARTO workflow, POPIA retention, the
    backup runbook. Anyone planning from it would have rebuilt work that existed. Now 4,
    three of which this wave closed. The hedge that let it drift, *"sections outside this
    release retain their last audited status"*, is gone. `CRON.md` documented **7 steps
    against a route that runs 15**. `SECURITY.md` §1 claimed isolation is "never by
    application filtering", which stopped being true when the public API shipped; it now
    names exactly two deliberate exceptions and says a third must be argued for there
    first, with §5b setting out what the API chokepoint does and does not buy. `README.md`
    described only the farm half and advertised deferred WhatsApp. `.env.example` told you
    to set `TEST_DATABASE_URL`, which `run.sh` has never read.
  - i18n EN/AF at parity (**3 445 leaf keys**). Lint clean; **zero typecheck errors outside
    a concurrently-edited voice-assistant refactor** that is not part of this wave and was
    deliberately left uncommitted.

- **Wave 4b, two hardenings taken as decisions, and 115 translation keys that were never
  merged** (migrations `20260829130000`, `20260829130100`; suite section **G34**; 64 banners
  across four files, green; every new surface driven in a browser against the demo project):
  - **Both open decisions from wave 4 were taken and shipped.** Erasure now clears
    `audit_log.ip` / `geo_*` / `user_agent` on the SUBJECT's own rows
    (`20260829130000`), the §4.4 exception exists to protect the *integrity record*, and the
    diff, entity, timestamp and actor link do not need an IP address. And the F16 contractor
    guard is now **local** to the eleven `_perm` policies (`20260829130100`) rather than
    reached only through `app.has_permission`, so two independent locks must fail before a
    grant row could lift a linked contractor out of their access scope.
  - **Both are dated, not numbered, and that is load-bearing.** Migrations apply in filename
    GLOB order, so a `2026…` name sorts AFTER `05…`. `public.erase_personal_data` had already
    been restated three times, most recently by `20260820165542`, a `0511` would have been
    silently overwritten by the dated files that follow it. The function was **extracted from
    the current definition, not retyped**; hand-transcribing a body has now gone wrong three
    times in this project.
  - **A hardening that changes nothing is the easiest kind to get wrong unnoticed**, so G34 is
    mostly negative assertions, and the proof is numeric on BOTH sides. Locally: every
    persona's counts unchanged. On production, measured across the change: owner 15/54/7/5,
    operator 1/5/1/1, contractor 4/0/3/4, **identical cell for cell**. G34 also carries the
    positive control (a granted *operator* must still gain the wider fleet) so the contractor
    assertion cannot pass for the wrong reason.
  - **Mutation-tested, and the first attempt was a no-op that passed.** The M2 mutant inserted
    comment lines *before* the `set` clause instead of disabling it, so the scrub still ran
    and the assertion "passed" against unmutated code, the same class of silent-harness
    failure recorded in wave 3 and again by the accounting agent. Redone by deleting the whole
    statement: `G34 FAIL [ERASURE]` fires, and reinstating the 0507 predicate fires
    `G34 FAIL [LOCAL GUARD]`.
  - **The live drive found what nothing else could: 115 i18n keys that were never merged.**
    `/reports/schedules` rendered raw keys, `reportSchedules.title`, `reportSchedules.lead`
    and 85 more. The `0506` feature had shipped with its i18n fragment unmerged. Chasing it
    properly rather than patching one page found the real extent: 87 static keys, 12 dynamic
    (`family.*` / `format.*`, invisible to a static grep), 3 run statuses, a pre-existing
    `fuel.date`, and **12 `reportEmail.*` keys, which are the body of the emailed report
    itself**. Every scheduled report would have gone out reading `reportEmail.greeting` to
    accountants and banks, which is precisely who the feature exists to send to.
  - **Why nothing caught it, and what now will.** The suite tests the database; typecheck sees
    `t("reportSchedules.title")` as a valid string; lint has no opinion; the build succeeds.
    Only opening the page finds it. A sweep now walks all 438 source files, extracts every
    static `t()` key and every dynamic `` t(`stem.${…}`) `` stem, and checks both dictionaries:
    **0 missing in EN, 0 missing in AF, no empty dynamic stem.** Worth promoting to a gate.
  - **Driven live as four roles**: `/accounting` renders with the honesty card about the
    export being generic; `journal.csv` returns 200 with correct debit/credit columns; the
    packs sit inside the "Papers & licence" tab rather than costing 150px above the fold; an
    operator neither sees the card nor can reach the route (**403**); a **contractor is refused
    the sale pack**, which is the whole reason that refusal lives in the route rather than in
    RLS; and a compliance pack returns a real PDF (4 909 bytes, `%PDF-`).
  - i18n EN/AF at parity (**3 560 leaf keys**). Gates green (typecheck + lint + build +
    `db:test`).
  - **Two environment notes for the next reader.** The Windows temp directory was cleaned
    mid-session, destroying the portable Postgres *installation* (not just its data) and the
    Playwright install with it; both were rebuilt, Postgres from the zonky embedded
    distribution on Maven Central (22 MB in under two seconds, against ~24 KB/s from EDB's
    350 MB installer). And deleting `.next` under a running `next start` leaves a half-broken
    server answering on port 3000, a `pkill` that reports success may not free the port, so
    kill the listener by PID and wait for it.

- **Official Colour Palette + the UI/UX audit fixed** (no migration; gates green;
  shared first-load JS flat at **103 kB**; `design:lint` 0 violations, down from 291):
  - **The palette is now the app's**, from `FleetWise_Official_Colour_Palette.pdf`:
    Green `#00572C`, Gold `#EAA50C`, Black, Warm Cream `#F7F3E8`, White, Charcoal
    `#242824`, Warm Grey `#E6E2D7`. Applied by **redefining the `brand`/`sand` scales**
    rather than renaming ~1,900 classes, so every existing `text-sand-500` re-coloured
    at once. Two anchors cannot do their brand-assigned job accessibly and needed
    derived shades (documented in `docs/DESIGN.md` §1): **gold is 1.92:1 on cream** so it
    is a FILL, never text, `gold-600` is the shade that carries text; and **Warm Grey is
    1.17:1**, a surface tint and an invisible border, so `sand-300` is the shade that
    reaches the 3:1 SC 1.4.11 owes. Every step was solved numerically and verified, not
    picked by eye. `docs/DESIGN.md` is the contract.
  - **Audit findings closed.** `maximum-scale=1` removed, pinch-zoom had been disabled
    for every user, a hard **WCAG 1.4.4** failure, verified gone in the served HTML.
    `viewport-fit=cover` added, which is why `.pb-safe` (3 uses) and `.h-safe-tabbar`
    (0 uses) had been silently resolving to 0px. Manifest + `themeColor` unified on the
    brand green (they were `#16a34a` / `#166534` / `#00572c`, three greens, one of them
    stock Tailwind and in no token file). **Skip link** added (a keyboard user tabbed
    through up to 24 nav links on every navigation). First **`not-found.tsx`**, a bad id
    used to drop you on Next's default 404, unstyled, outside the shell, English only.
    Mobile "More" sheet now carries the **same groups the sidebar computes** (it was a
    flat 21-item list for a books partner whose desktop had 3 named sections); duplicate
    `partnerSettings` removed. **Login asked for your email twice**, one form now, two
    submits via `formAction`, plus the first "forgot password" affordance. The
    **unknown-sticker QR page**, the one screen a farm worker may ever see, gained the
    wordmark and a route onward, still zero-anon-DB.
  - **Images**: all 13 raw `<img>` → new `<Photo>` (intrinsic dimensions, lazy, async
    decode, real alt). Zero had dimensions or lazy loading before, so the machines list
    fetched every photo at once and shifted layout as each landed. Recorded honestly in
    `lib/storage-image.ts`: Storage resizing is **paid and env-gated off**, and the
    **batch `createSignedUrls` takes no `transform`** (only the single-object call does,
    and the signature covers the transformation), so lists take the no-server-support
    wins and say so rather than pretending.
  - **Tables**: 10 hand-rolled tables → the kit, recovering **67 header cells** that had
    no `scope="col"`. Kept out of it deliberately: `role="presentation"` email layout
    tables, and the printed-document miniature, both exempted with reasons.
  - **DARK MODE**, and the architecture that makes it possible. The five semantic
    surface tokens in `globals.css` were defined and referenced **zero** times, that
    missing layer was *why* there was no dark theme. Now the `sand` scale is CSS
    variables and **flips per theme**: a step is a ROLE (distance from the ground), and
    every dark step was solved to the same contrast duty its light twin owes. `brand`
    does NOT flip, a green button is green in both themes, so green-as-text moved to
    `text-brand-ink` (the deep `#00572C` is 7.89:1 on cream and **1.27:1** on near-black).
    Three states honoured: system, and an explicit choice winning in **both** directions.
  - **A real pre-existing bug**: `text-status-warn` (15 uses) and `text-status-bad` (4)
    were defined in **no version** of the config. Tailwind emits nothing for an unknown
    token, so those cells, including the 60-day debtors column, rendered as ordinary
    body text. Defined, and `design:lint` now fails on any undefined token.
  - **Errors stop leaking codes.** 259 redirect paths, 232 carrying raw English or a raw
    Postgres message, rendered verbatim by pages that fell through to printing the code.
    New `lib/errors.ts` maps **107 codes → translated sentences** and never returns the
    code; 31 render sites routed through it. `Field`'s `error` prop was passed a value
    **once in the whole app** and `aria-invalid` was never true, `SelectField`/
    `TextareaField` now wire both (only `TextField` did).
  - **Three new gates, all mutation-tested** (each rule proven to fire before being
    trusted): `pnpm design:lint` (palette, type scale, gold misuse, images, tables,
    undefined tokens, viewport, manifest + a 12-case contrast contract),
    `pnpm errors:check` (every emitted code resolves in EN and AF, it caught a code
    my own first regex had truncated), and the existing `i18n:parity`.
  - **Type scale**: 32 distinct sizes → 9, with 151 arbitrary `text-[1.05rem]`-style
    one-offs remapped. `em` sizing is deliberately exempt (relative icon sizing).
  - **Verified in a browser**, both themes, at 412px: **0 contrast failures measured on
    real rendered pixels**, 0 tap targets under 48px, 0 overflow, 0 JS errors. All three
    theme states proven, including surviving a reload.
  - i18n EN/AF at parity (**3 633 leaf keys**). Gates: typecheck, lint, build,
    `design:lint`, `errors:check`, `i18n:parity`, all green.
  - **NOT verified**: only the four pre-auth surfaces could be rendered. `.env.local`
    here comes from `vercel pull` with every secret redacted to `"[SENSITIVE]"`, so no
    authenticated screen was driven and `db:test` was not run (no schema change was made).
    A pass over the 61 authenticated screens with working credentials is the outstanding
    work, dark mode especially, which is correct by construction and by contrast maths
    but has been *seen* on three pages.


- **FleetWise SaaS subscription billing, Paystack** (migrations `20260903160000`,
  `20260903160100`, `20260903160200`; branch `claude/paystack-saas-billing` off `e298808`;
  suite `supabase/tests/billing_subscription.sql`, 17 sections / 110+ assertions, green;
  **mutation-tested 10/10 caught with a passing control**; **NOTHING CHARGES ANYONE AND
  NOTHING CAN**):
  - **The scope boundary is the design.** This is farms paying Rapid Rise for software -
    one direction. It is not the money between a farm and its contractors
    (`partner_documents`/`partner_payments`), and the dormant PayFast seam in
    `src/lib/payments/*` was not touched, read or imported. Every table is prefixed
    `billing_`; §(k) asserts no billing function's `prosrc` mentions a partner table. No
    Paystack transfer, split, subaccount or payout exists anywhere.
  - **PRICES CONFIRMED 2026-09-04 (migration `20260904120000`).** The founder confirmed the
    founder document: Essential **R44** / Professional **R73** / Complete **R89** /
    Done-For-You **R250** per vehicle per month, VAT-inclusive, annual charging ten months.
    Seeded as the `launch-2026` generation, and `src/lib/entitlements.ts` corrected from
    R39/R69/R99/POA to match, a screen quoting R39 while the invoice says R44 is worse than
    either number alone. A test reads the migration itself to prove the two agree, and §(0)
    asserts the same figures in SQL, so they cannot drift apart silently again. **This
    releases the FIRST lock only**: invoices can now be RAISED, and with
    `BILLING_CHARGING_ENABLED` still unset nothing can be CHARGED. Mutations M9/M10 prove
    the price assertions fire.
  - **Two locks stopped any charge, and both were deliberate.** `billing_price_versions` shipped
    **EMPTY**, the founder doc (R44/R73/R89/R250) and shipped `entitlements.ts`
    (R39/R69/R99/POA) disagree, so no price was chosen and with no active version the
    generator raises nothing. And `BILLING_CHARGING_ENABLED` is unset: every method that
    would move money checks it **before making any network request**, asserted on an
    injected fetch spy rather than on a return value. The conflict is recorded as founder
    decision **#7**, with #8 (not VAT-registered) and #9 (dunning policy, PROPOSED).
  - **Subscription state lives in Postgres, not at Paystack**, the amount changes with
    each farm's vehicle count, so a provider-side Plan object would be wrong the moment a
    tractor is sold. Paystack only moves money.
  - **Two plans, and the reason there are two.** `farms.plan` stays the EFFECTIVE plan that
    every existing gate resolves from; `billing_subscriptions.plan` is the COMMERCIAL plan
    they bought. Dunning writes the former and keeps the latter, so the downgrade needed
    **no new entitlement code at all** and recovery restores the exact prior state.
    Nothing is ever deleted for non-payment; §(l) asserts machines, job cards, cost
    entries and invoices are unchanged in count across a downgrade.
  - **VAT**: Rapid Rise is not registered, so `app.billing_force_vat_rate` forces every
    invoice to 0% and a null VAT number, overruling the caller, mirroring the partner-side
    guard in `0401`. No VAT line, never headed "Tax invoice" (VAT Act s20(4)). The full
    machinery is built anyway: registering is a flag flip that restates **no** historical
    invoice, asserted in §(h2).
  - **The double-charge problem is solved by a unique index, not by checking.**
    `billing_payment_attempts_inflight_uq` permits at most one `pending`/`unknown` attempt
    per invoice, and *claiming is inserting that row*, so the second worker loses on a
    duplicate key in the same instant. A lost HTTP response settles **`unknown`**, never
    `failed`, which BLOCKS the invoice until `transaction/verify` on that exact reference
    resolves it. Nothing charges again to resolve an unknown.
  - **Three defects found by RUNNING what reading called correct.** (1) A boolean singleton
    primary key on `billing_settings` broke the shared `app_audit()` trigger, which casts
    `id` to uuid, it would have failed the first time anybody edited the dunning policy.
    (2) **`0102_grants.sql`'s `ALTER DEFAULT PRIVILEGES` meant `authenticated` COULD read
    `billing_payment_methods.authorization_code`**, a Paystack charging credential, because
    a migration saying "we deliberately do not grant this" was true of itself and false of
    the database. RLS does not help: it filters ROWS and this is a COLUMN. Fixed with an
    explicit `revoke` before every grant, and written into `SECURITY.md` §2b as a standing
    hazard for every future table. (3) The invoice generator created invoices as `open` and
    then inserted their lines, which `app.billing_freeze_invoice_line` refuses, **every
    invoice would have aborted**. It now assembles as `draft` and issues in the same
    transaction.
  - **A mutation survived the first pass**, which is why §(h3) exists: the suite tested the
    VAT *arithmetic* but never that the *guard* forces the rate to zero, so disabling the
    guard went unnoticed. Re-run: 8/8 caught.
  - **184 i18n keys would have shipped missing.** The UI agent was cut off before writing
    its fragments, and nothing catches this, parity only compares EN to AF, so both were
    equally wrong. The billing screens would have rendered `adminBilling.colFarm` to users,
    exactly as `/reports/schedules` did in wave 4b. Written in genuine EN + AF (195 keys),
    merged behind a guard that refuses a fragment that is not itself at parity, overwrites
    an existing key, or ships Afrikaans identical to English, which caught one. A sweep of
    all **470** source files now shows **0 missing in EN, 0 in AF**, dynamic stems included.
    **Worth promoting to a gate**; it still is not one.
  - Adapter `src/lib/billing/paystack.ts` behind the existing seam (`index.ts` gained the
    `case`, plus `getSaasBillingProvider()` returning **null** for no-op rather than a stub
    that pretends). Config read lazily and fail-closed. Routes: hosted-checkout init,
    informational-only callback (never grants access), signature-verified webhook, and a
    **separate** `/api/cron/billing` at 03:20 so a billing failure cannot disrupt the
    maintenance pass. Owner `/billing` and rr_admin `/admin/billing` with kill-switch state
    in words.
  - Paystack's contract was **verified against their live documentation**, not assumed:
    HMAC-SHA512 of the raw body keyed with the API secret (no separate webhook secret), the
    `charge_authorization` fields, "only the email used to create an authorization can
    charge it" (why `authorization_email` is stored beside the code), "only use the code if
    `reusable` is true", the retry cadence (3 min × 4 then hourly for 72 h, which is why
    the route returns 200 for anything recorded), and the IP allowlist. The allowlist is
    **deliberately not enforced**: the HMAC is stronger, the source IP behind Vercel's proxy
    is an attacker-influenced forwarded header, and a provider IP change would silently
    break every payment.
  - Verified: 82 TS tests, all migrations applying to a fresh Postgres in order (138 files),
    the suite, the mutation suite, and TS-vs-SQL VAT agreement across 140 (amount, rate)
    pairs. Gates green, typecheck, lint, build, `design:lint`, `errors:check`,
    `i18n:parity` (**3 842** leaf keys). Shared first-load JS unchanged at **103 kB**.
  - **NOT verified, no credentials existed in this session**: no live or test Paystack call
    has ever been made, the webhook has never received a real delivery, the cron has not run
    on Vercel, and `pnpm db:test` could not run (no Postgres in PATH, PGlite stood in,
    which is a real Postgres but not the project's own harness). Docs:
    `docs/BILLING.md` (design + runbook) and `docs/PAYSTACK_GO_LIVE.md` (the manual steps).


- **Paystack billing DEPLOYED, and the two things that stopped it working**
  (migration `20260906120000`; commits `e0073b6`/`f282e1a`/`33fb096`/`bc24279` on `main`;
  applied to the demo project and driven against it):
  - **The branch did not build in isolation.** `pnpm typecheck` passed in the working tree
    and failed on a clean checkout, which is what Vercel builds. Three imports resolved
    only against the UI/palette session's UNCOMMITTED files: `layout.tsx` had been
    committed carrying that session's shell rework (the `MoreMenu` `groups` API, a theme
    toggle), and the billing pages imported `@/lib/errors` and `@/lib/security/same-origin`.
    Reverted `layout.tsx` to main's version plus the five lines billing actually needs, and
    brought across only the two small self-contained modules, rather than shipping another
    workstream's in-flight work. **The palette overhaul and the concurrent Codex work stay
    uncommitted**; `main` has billing and nothing else.
  - **The charging path was unreachable.** Every engine function lives in `app` and is
    revoked from everyone but the owner, correct, they move money, but PostgREST exposes
    `public` ONLY, so all four `supabase.rpc("billing_…")` calls in `service.ts` resolved to
    no function. Raising an invoice, claiming a charge, settling an attempt and listing what
    is due each failed at the first statement. **Nothing caught it**: the TS tests mock the
    Supabase client so they assert the ARGUMENTS and never reachability; `db:test` never
    calls the database the way the app does; the build compiles a string. Found by
    inventorying every `.rpc("…")` name against `pg_proc` on the live database, SCHEMA_DRIFT's
    "count objects, not migrations", pointed at the CALLING side. Suite section **(m)** is the
    guard, asserting names AND parameter names (PostgREST resolves overloads by the named
    arguments, so a rename breaks the call as completely as a deletion).
  - **Nothing created a subscription.** `beginCheckout` refuses with
    `billing-no-subscription`, so a farm could never start paying, the feature was reachable
    only by hand-writing a row. `app.start_billing_subscription` reads the trial from
    `billing_settings` and leaves `current_period_start` NULL so the first BILLED period
    begins when billing begins, not on the day the button was pressed. **Still no UI for it**
   , an rr_admin control on `/admin/billing` is the remaining go-live gap.
  - **Two mutations, both caught**, renaming `p_limit` fires (m) and passes (j), proving (m)
    covers a dimension (j) does not; granting a wrapper to `authenticated` fires (j). The
    first mutation run was a **no-op the harness reported as a survivor** (it reads migrations
    from the repo, not the copy I edited), the third time this project has had that.
  - **A GitHub push-protection block was fixed, not bypassed**: `safety.test.ts` carried a
    realistic FAKE `sk_live_…` literal to prove the redactor strips it. Assembled by
    concatenation instead, same runtime value, no credential-shaped string in the source.
  - **Repo == production proven across 1,071 billing objects** in ten categories. Two
    apparent mismatches were measurement artifacts, both now in `SCHEMA_DRIFT.md` territory:
    PGlite records NOT NULL in `pg_constraint` and Supabase's build does not (`c/f/p` match
    exactly, and NOT-NULL-ness is compared in the `column` category anyway); and `0410`/`0432`
    were checked out CRLF on Windows, so stripping the CRs makes all three hashes equal
    production. **The credential lock holds on production**: `authorization_code` is not
    readable by `authenticated`, `last4` is.
  - **Live on `farming-machinery-asset-manager.vercel.app`**: webhook returns **401** to an
    unsigned request, `/billing` **307**s to login, `/api/cron/billing` returns **401** without
    the bearer. Prices seeded (R44/R73/R89/R250). One test subscription exists -
    **Rooikoppies Plaas, professional/monthly, trial 0**, with invoice **FW-2026-000001 for
    R219,00** (3 x R73, VAT 0, due 2026-09-13). Nothing has been charged; no card is stored.
  - **Still unverified, all needing the founder**: no Paystack call has ever been made,
    the webhook has never received a real delivery, and the cron has not fired on Vercel.
    `NEXT_PUBLIC_SITE_URL` in Vercel Production could not be read from outside and every
    checkout callback is built from it. The Rooikoppies owner's email is a `.example`
    address, which Paystack may reject.


- **The first real payment, and the four things it exposed** (migrations `20260906120000`,
  `20260907120000`; commits `bc24279`/`4cae862`/`716c928` on `main`; every migration applied
  to the demo project and driven against it):
  - **A live Paystack payment completed end to end**, hosted checkout → signed webhook →
    ledger → receipts. Invoice `FW-2026-000001`, R219,00 (3 x R73), Visa ••••4081 stored
    `reusable=true`. **1 payment row, not 2**, despite the webhook and the callback verifying
    the same transaction **0.558 seconds apart**: the unique index on the transaction id did
    its job under a real race rather than a simulated one.
  - **The charging path had never been reachable.** Every engine function lives in `app` and
    PostgREST exposes `public` only, so all four `supabase.rpc("billing_…")` calls resolved
    to nothing. Found by inventorying every `.rpc()` name against `pg_proc` on the live
    database. Suite section **(m)** now asserts each name AND its parameter names, PostgREST
    resolves overloads by the named arguments, so a rename breaks the call as completely as a
    deletion. Mutation-tested: renaming `p_limit` fires (m) and passes (j).
  - **Nothing could put a farm on a subscription.** `beginCheckout` refuses without one, so
    the feature was reachable only by hand-writing a row. `app.start_billing_subscription`
    reads the trial from `billing_settings` and leaves `current_period_start` NULL so the
    first BILLED period begins when billing begins, not on the day the button was pressed.
    `/admin/billing` now lists farms with no subscription and starts one.
  - **Every button on `/admin/billing` was dead.** The forms posted `attemptId`, `invoiceId`,
    `subscriptionId`, `billingPeriod`; the actions read the snake_case names. So reconcile,
    retry-charge and change-plan all bounced with `?error=missing-id` and did nothing.
    `FormData.get` returns `string | null` whichever you ask for, so it typechecks and builds
   , only pressing the button finds it. And the error rendered as the generic apology
    regardless, because **not one of the twenty billing codes was mapped in `lib/errors.ts`**;
    they are now, and the ones about money answer first whether anything was charged.
  - **Receipts and failure notices** (`20260907120000`). Paystack's receipt carries the amount
    and a reference and nothing else, not our invoice number, the period, "3 vehicles at
    R73", the registration number, or the VAT position. There is now a branded PDF emailed on
    payment, rendered from the invoice's own frozen snapshot so a copy reprinted next year
    shows the company as it was. A failed renewal now emails too, per attempt, instead of
    writing an in-app alert a farmer who is not logged in will never see. Sending is CLAIMED
    the way charging is; a failed send hands the claim back with the reason, a failed notice
    does not (re-sending "your payment failed" nightly over a full mailbox harasses the
    customer about our problem). The receipt goes out via `after()`, so Paystack still gets a
    prompt 200. **Proven by generating bytes**: five PDFs rendered and their text decoded out
    of the compressed streams, reference, reg number, card, amount all present; Afrikaans
    fully translated; the VAT branch correct in both directions; 0 header truncations in
    either language.
  - **Demo accounts point at one real inbox.** All 14 were on `.example` domains, which cannot
    receive mail and which Paystack may reject. Now Gmail plus-addresses on one mailbox,
    changed across `auth.users`, the `auth.identities` JSON and `public.users` together,
    piloted on one and verified by a real sign-in before the other thirteen were touched;
    14/14 authenticate afterwards.
  - **Two environment notes.** `.env.local` here comes from `vercel pull` and its
    `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` are PLACEHOLDERS (the service key's JWT
    payload is just `{"role":"service_role"}` and returns 401); the ANON key is real, which is
    what made verifying the renamed logins possible. So the cron route cannot be triggered
    from here.
  - i18n EN/AF at parity (**3,898 leaf keys**). Gates green in an isolated worktree -
    typecheck, lint, build, shared first-load JS flat at **103 kB**; suite green at 141 files.
  - **Still unverified**: the automatic renewal (`charge_authorization`) has never run, it is
    a different endpoint and a different code path from hosted checkout. `FW-2026-000002` is
    staged and due so one press of "Retry payment" exercises it. Email has never actually
    sent: `RESEND_API_KEY`/`EMAIL_FROM` must be set in Vercel or the pass reports
    `skipped (email-not-configured)` and claims nothing.


- **Billing driven end to end on production, and the four things that were still only
  assumed** (migrations `20260909120000`, `20260909140000`; commits `60e1941`/`57995f0`/
  `869c483` on `main`; both migrations applied from disk over a direct Postgres connection):
  - **The credentials changed what could be tested, and that is the headline.** `.env.local`
    came from `vercel pull`, which CANNOT decrypt secrets, it writes placeholders. So the
    service key was a 76-char stub whose JWT payload was literally `{"role":"service_role"}`,
    `RESEND_API_KEY` was `[SENSITIVE]` (truthy, so `emailConfigured()` said yes and Resend
    refused it), and `PAYSTACK_SECRET_KEY` was absent, the founder had added it under the
    name `PAYSTACK_TEST_KEY`, which the code does not read. With the real values in place,
    plus a direct `DATABASE_URL`, everything below became reachable from here. **The `#` in
    the database password broke URL parsing** and was percent-encoded to `%23`.
  - **The first reconciliation this system has ever had.** Both directions: every payment we
    recorded exists at Paystack with the same amount, reference and currency; and, the
    direction that matters, **every successful Paystack transaction was recorded by us**,
    which is what catches a farmer who paid while the webhook went missing. 5 payments,
    R1 095,00 on both sides, 0 discrepancies, balance agreeing exactly.
  - **The `unknown` guard ran for the first time.** Claim → charge the LIVE Paystack API →
    settle `unknown` as though the response were lost. Proven: the invoice is BLOCKED, a
    second claim is refused, reconciliation resolves it by verifying that exact reference,
    and **exactly one payment** exists afterwards. This is the mechanism that stops a double
    charge and nothing had ever exercised it.
  - **The whole nightly pass ran on production**, all nine steps, same functions, same
    order as the cron route, and charged a due invoice unattended. The webhook signature is
    now proven NON-circularly: 5 real Paystack deliveries, every one `signature_verified`,
    every one processed clean. Until now we only ever checked our HMAC against our own HMAC.
  - **Three defects found.** (1) `formatNotification` knew thirty templates and **not one
    billing template**, while the dunning engine has been writing `billing_payment_failed`
    since it shipped, `default: return template` meant a farmer whose card was declined read
    that literal string in their alert centre. (2) **Card expiry was stored and read by
    nothing**: `exp_month`/`exp_year` sat there since the table was created, so a card
    stopping walked the farm down the entire 31-day ladder as though they had refused to pay.
    (3) The `/admin/billing` forms/actions field-name mismatch, fixed earlier in the week.
  - **A design call reversed after watching it fail.** `20260907120000` gave receipts a
    release and deliberately withheld one from failure notices, to avoid nightly re-sends
    over a full mailbox. The local run failed on the bad Resend key and stamped the attempt
    notified anyway, exactly the shape where a farmer is NEVER told and loses their plan 31
    days later in silence. A duplicate email is an annoyance; that is not. `20260909140000`
    gives notices the same release, and the live run confirmed both come back into the queue
    with the reason recorded.
  - **Suite sections (n) and (o)**, 12 mutations, 12 caught, two controls survived. (n) drives
    the dunning ladder rather than hand-setting where it ends, §(l) reached a downgrade by
    WRITING `status='grace'` onto the row, so `billing_register_failure` had never been
    called and the retry offsets had never run. Each rung is asserted against the **setting**
    that produced it, because the offsets are configuration and an engine with them baked in
    would pass every other assertion while the screen did nothing. (o) hammers the card-expiry
    arithmetic, "12/28" means the END of December, and its last assertion is the one that
    would have caught defect 1: every billing template this database actually PRODUCES must
    be one the renderer was taught, judged on real rows because SQL cannot call TypeScript.
  - **Repo == production**, measured after applying: 48 billing functions byte-identical,
    3 differing ONLY by CRLF (the known Windows-checkout artifact on `0410`/`0432`), 0 real
    drift, 0 missing. The `constraint` category still differs 174/69 because PGlite records
    NOT NULL in `pg_constraint` and Supabase's build does not, NOT-NULL-ness itself is
    compared in the `column` category, which matches.
  - Demo state: **5 paid invoices, R1 095,00**, subscription active, next billing 2027-02-06,
    one stored Visa (test-mode, expiring 12/2030). i18n EN/AF at parity (**3,906 leaf keys**).
    Typecheck, lint and an isolated build green; suite green at 146 files.
  - **Still unproven**: a REAL Paystack decline (test mode always accepts a valid stored
    authorization, so this needs a declining card stored through hosted checkout in a
    browser); grace → downgrade → restore on PRODUCTION rather than PGlite; the annual
    invoice on production. **Not built**: receipt download from `/billing`, refunds,
    proration, and the self-serve sign-up + quota model planned in
    `docs/SIGNUP_AND_QUOTA_BILLING.md`.

- **The billing audit, and the five defects that stopped revenue silently** (migrations
  `20260910120000`, `20260910140000`; commits `e25b55a`/`c909986` on `main`; suite sections
  **(p) (q) (r)**, 17 SQL mutations + 4 TS mutations, all caught, controls survived; both
  migrations applied to production from disk and each defect then DRIVEN against the live
  database inside a rolled-back transaction):
  - **Every one of these stops money with no operational symptom.** No error, no failing
    cron, no alert, the only evidence is money that quietly stops arriving from a customer
    who is still using the product. That is why they are grouped: the shared failure is a
    ledger that reports success while doing nothing.
  - **S1, every farm was invoiced ONCE, ever.** `app.generate_billing_invoices` computed
    its period as `coalesce(current_period_start, next_billing_on)` and then wrote
    `current_period_start` back onto the subscription. The second time a farm came due,
    `coalesce` found the value the function itself had written, recomputed the identical
    period, lost to `billing_invoices_farm_period_uq`, and hit the `continue`, which skips
    the block that advances `next_billing_on`. The row is then stuck: due today, for ever,
    producing nothing, while the function returns 0 and the cron reports
    `generate_invoices: ok`. It also burned an invoice number per failed attempt, so the
    numbering acquired permanent gaps. Fixed to `coalesce(current_period_end + 1, …)`, a
    value the function reads but never rewrites into its own input. **Production was
    ARMED**: Rooikoppies had `current_period_start` set, so it would have raised nothing
    again.
  - **Why nothing caught it, which is the transferable part.** Every test of that generator
    hand-advanced `current_period_start` first, the suite at §(i2), and every staging
    script used to drive production that week. That is exactly the column the bug fails to
    advance, so priming it made a broken generator produce the right answer for the wrong
    reason. Section **(p)** drives three consecutive billing dates moving ONLY
    `next_billing_on`, asserts contiguity in both directions (a gap is a month nobody is
    billed for; an overlap is a month billed twice), and runs the third pass three days
    LATE, a cron that runs late must bill the period that was owed, not a shorter one
    starting today.
  - **S2, an `unknown` attempt could never be resolved.** `reconcileAttempt` handled
    `deferred` and `pending`; an attempt already at `unknown` fell through to `still-open`
    for ever. So a charge whose request never reached Paystack jammed its invoice
    permanently: never charged again, never `past_due`, no reminder, no failure email, and
    on every screen indistinguishable from a customer who was paid up.
  - **The obvious fix was wrong, and dangerously so.** Settling `abandoned` on
    `retryable === false` looks right until you read the adapter: `retryable: false` is
    produced by FOUR situations and only one is Paystack answering. A missing API key, a
    reference we never managed to send and a malformed 200 are all non-retryable, and none
    is an answer about the customer's money. Since `abandoned` UNBLOCKS the invoice, the
    broad version hands an in-flight `unknown` back to the charging queue because OUR
    config broke. `VerifyResult` therefore gains a **required** `answered`, set only where
    Paystack returned its own `status:false` envelope; the worker requires
    `retryable === false && answered`. Required rather than optional so the compiler forces
    the next adapter to decide, it found all three call sites.
  - **S7, the charging path never looked at the FARM.** `farms.deleted_at` and
    `farms.status` were read nowhere on it; `farms` was selected only to copy a name onto
    an invoice snapshot. A soft-deleted, suspended or cancelled farm went on being invoiced
    and charged. Now: generation requires `trial`/`active`; charging refuses DELETED and
    CANCELLED but still offers SUSPENDED, suspension withholds the service, it does not
    forgive what was already supplied. **The asymmetry is pinned in both directions**,
    because tidying it into one rule breaks one half.
  - **S11, "Try again" told a paying customer nothing was due.** `retryInvoiceCharge`
    rebuilt the AUTOMATIC shortlist, which carries `next_retry_on`, so after a decline the
    owner's button answered "nothing is due" for three days. Worse and not in the original
    finding: once retries are exhausted the status is `grace` and then `downgraded`, and
    NEITHER is in that shortlist, so from the moment a farm entered grace **the stored card
    was never presented again by anything**, not the cron, not the customer. The UI has
    been offering that button in `past_due`, `grace` AND `downgraded` since it shipped: it
    was visible and dead in all three. New `app.invoice_chargeable_now` is a SEPARATE
    function, not a flag on the automatic one, so the nightly cadence cannot be relaxed by
    something passed the wrong way round. It drops the retry window and admits `grace`,
    `non_renewing` and `downgraded`, the last is what gives the downgrade design's "pay
    and get it back" promise any mechanism at all. It relaxes NOTHING else: the in-flight
    block still holds, and the farm check moved into the caller because the function is
    keyed on the invoice alone.
  - **S5, a payment resurrected a cancelled subscription.**
    `billing_restore_after_payment` read only `cancel_at_period_end`, so a payment landing
    after an IMMEDIATE cancellation set the row back to `active` with `ended_on` in the
    past, to be billed again next month. Not exotic, it is what happens when somebody
    cancels while a charge is in flight, which is the whole premise of `unknown`.
  - **A mutation harness that reported two survivors it had never applied.**
    `String.prototype.replace` with a string pattern replaces only the FIRST match, and the
    first match for both period mutants was the copy of that line quoted in the migration's
    own header comment. The mutants edited prose, the function was untouched, the suite
    passed, and both were reported as SURVIVED. Fourth instance of this class in this
    project. The harness now requires the anchor to occur **exactly once**, "never
    applied" and "survived" have to be different words or a mutation run is theatre.
  - **Also worth knowing for the next editor**: `supabase/tests/billing_subscription.sql`
    has MIXED line endings in the working tree (CRLF from the Windows checkout, LF in
    blocks appended by scripts), so a multi-line literal match works in one region and
    silently fails in another. Match on `\r?\n`. Git normalises on commit, so the blob is
    uniform.
  - Gates: 222 TS tests, typecheck, lint, and the billing suite green. Every migration
    byte-identical between repo and production after applying.
  - **Put to the founder, not decided**: whether the nightly pass should keep trying the
    card during GRACE. It currently never does, which leaves money uncollected from
    customers still using the product, but the dunning cadence is founder decision #9.
  - **Still open from the audit**: S3 (plan change is two half-controls, `/admin/farms`
    writes `farms.plan`, `/admin/billing` writes `billing_subscriptions.plan`, neither
    touches the other, so an upgrade charges more and grants nothing while a downgrade
    charges less and keeps everything; no proration, no self-serve), S4 (registering for
    VAT makes every pre-registration invoice un-updatable), S6 (15 `settleBillingAttempt`
    call sites discard the error), S8 (a price rise silently reprices existing customers;
    `price_version_label` is written and never read), S9, S10, S12. **From the Paystack
    research**: the Starter Business **R80,000 lifetime collections cap** must be cleared
    before go-live; disputes (`charge.dispute.*`) are unhandled and SA gives 48 business
    hours before Paystack auto-accepts; refunds are ignored entirely; `reversed` maps to
    `failed`, which duns a farm you refunded. **Not started**: the receipt PDF redesign,
    and the sign-up + quota + upgrade/downgrade build in
    `docs/SIGNUP_AND_QUOTA_BILLING.md`.

- **Production-readiness pass: grace, prices, plans, refunds, quotas and the gate**
  (migrations `20260910160000`, `20260910180000`, `20260910200000`, `20260910220000`,
  `20260910230000`, `20260911100000`; commits `691f36e`/`e7c8d7a`/`dcf5115`/`7c67c63`/
  `60fab9b` on `main`; suite sections **(s) (t) (u) (v) (w)**; every migration applied to
  production and each behaviour then DRIVEN against the live database inside a rolled-back
  transaction):
  - **Four founder decisions taken 2026-09-10**, all recommended options: a mid-cycle
    UPGRADE charges the pro-rata difference immediately; a DOWNGRADE takes effect at period
    end with no refund; GRACE is retried weekly; and a price rise does NOT reach farms that
    already signed up. Plus: the Paystack Starter Business **R80 000 lifetime cap** is not a
    launch blocker at this volume, the founder upgrades to Registered Business at R10 000
    collected (recorded in memory as `paystack-account-tier`).
  - **Grace is retried (`20260910160000`).** Exhausting the ladder set `next_retry_on = null`
    and `grace` was not in the charging shortlist at all, so from the moment a farm entered
    grace **nothing presented the card again**, not that night, not ever. A card that failed
    on the 1st very often works on the 25th. `grace_retry_days` joins the audited settings
    row; 0 restores the old behaviour exactly, which is why the grace arm tests
    `next_retry_on is not null` rather than coalescing: in grace a null date means the retry
    is OFF and must never read as "charge now". Grace itself is not extended by a retry.
  - **A price rise stops reaching existing customers (same migration).**
    `billing_price_versions_active_uq` permits one active row per (plan, period), so
    publishing a new price necessarily retired the old one and every existing farm's next
    invoice was raised at the new figure, silently, no notice, no decision recorded.
    `billing_subscriptions.price_version_id` pins what they bought; the pin is honoured even
    once that version is RETIRED, because a retired price is exactly what a grandfathered
    customer is still paying. It is ignored only when it no longer fits the plan they are
    on. Clearing it is how somebody is deliberately moved.
  - **S3, plan change was two half-controls (`20260910180000`).** `/admin/farms/[id]` wrote
    `farms.plan`; `/admin/billing` wrote `billing_subscriptions.plan`; neither touched the
    other. So an upgrade through billing charged Complete money and stayed gated at
    Professional, an upgrade through the farm screen gave the features away, and a downgrade
    reduced the bill while leaving everything open. There was no self-serve path at all. The
    two-plan split is still deliberate, it is what lets a non-payment downgrade restore the
    exact prior state, so the fix is one function that moves both together, with proration
    on an upgrade and a scheduled `pending_plan` on a downgrade.
  - **S4, registering for VAT broke every earlier invoice (`20260910200000`).** The VAT
    guard stamps the seller's number onto any invoice that has none; on an UPDATE to a
    pre-registration invoice that changes a frozen snapshot field and the freeze raises. So
    the first payment against any old invoice after registering **aborted the transaction
    that recorded it**, Paystack has the money, FleetWise has nothing. §(h2) asserted the
    values and never that a later write survives.
  - **S6, charged, and not recorded.** `settleBillingAttempt` returns `{error}` and all
    sixteen call sites ignored it. It is the only thing that inserts a payment row, so a
    failure in the success branch means the card was charged, nothing was written down, and
    the worker still returned `succeeded`. It now reports `unknown` with the reason, and
    `unknown` outcomes now reach `summary.errors`, which the cron drains into Sentry. Until
    then **no `unknown`, from any cause, had ever been reported anywhere**.
  - **A reversal is not a decline.** `reversed` folds into `failed` (right for the invoice)
    and `failed` starts the dunning ladder (wrong for the customer, their card worked and
    we sent the money back). `settle_billing_attempt` gained `p_dun`; the old 8-argument
    overload was DROPPED, because two overloads reachable over PostgREST, which resolves by
    named arguments, is an ambiguity waiting to pick one.
  - **Disputes and refunds reached nobody.** Both were `outcome: "ignored"`, recorded in
    `billing_webhook_events` and then nothing. South Africa gives roughly **48 business
    hours** to answer a dispute before Paystack accepts it for us and takes the money from a
    payout. They now alert Rapid Rise and only Rapid Rise, farm-scoped for RLS but
    rr_admin-addressed, no quiet hours, deep-linking to `/admin/billing`. What a refund does
    to the ledger and the plan is deliberately NOT decided here.
  - **The quota model (`20260910220000` + `20260910230000`).** Billing was metered: count
    the machines, charge that many, so the bill moved on its own. Farms now BUY slots.
    **A null quota means "bill what you count, no ceiling"**, every subscription that
    exists has one, and the inverse would have repriced the whole customer base to nothing
    and locked them out of adding a vehicle. Two of section (v)'s mutants are caught by
    EARLIER sections whose fixtures the defect destroys, which is the blast radius shown
    rather than described.
  - **The ceiling is a TRIGGER, not three checks.** There are three creation paths
    (`createMachine`, CSV `importMachines`, and a contractor's `syncClientVehicles`).
    A trigger covers every path including ones nobody has written, cannot be raced by two
    tabs, and gives CSV import all-or-nothing for free. The actions keep a pre-check purely
    for the wording, and the contractor gets a different sentence because they are not the
    one paying. Three things it must NOT refuse, all asserted: filling the last slot bought,
    filing an already-retired machine, and editing a machine on a full farm.
  - **The access gate (`20260911100000`).** "A subscription EXISTS and is pending", never
    "there is no active subscription", Weltevrede has twelve vehicles and no subscription
    row. It is SECURITY DEFINER because the billing SELECT policy admits only a farm's
    billing admin: a layout reading the table through the caller's client gets a row for an
    owner and **nothing for an operator**, and "nothing" reads as "no subscription,
    therefore fine". A gate correct for one role and wrong for the rest is worse than no
    gate. `/activate` lives in `(auth)` so it cannot bounce to itself.
  - **What the mutation runs bought this time.** A mutant that claimed to break two
    functions changed only one, because the harness applied one (from, to) pair per mutant -
    and its SURVIVED line read as evidence for something nobody had tested. The harness now
    takes a list of edits with the exactly-once guard on each. Another mutant was malformed
    and produced a SQL syntax error rather than testing anything; a mutant that cannot parse
    tests the parser. Three assertions in (v) were "caught" only as raw `check_violation`
    stack traces and were rewritten to say which rule broke.
  - **Section (o) was date-flaky and 11 September 2026 is the day it tripped.** It picked
    its "expiring soon" card as `current_date + 20`, and a card expires at the END of its
    printed month, so on the 10th that meant 30 September (inside the 45-day window) and on
    the 11th it meant 31 October (outside it). It passed for the first third of a month and
    failed for the rest with nothing about the engine having changed. Now pinned to the
    current month, whose end is at most 31 days away.
  - **Two enumerating sections had to be widened, and both refused the work until it was
    argued for.** (j) had never had an allowlist for a `public.*` wrapper a browser may call,
    because until now every one moved money; `farm_vehicle_allowance` and `farm_billing_gate`
    had to pass four written-down tests. (m) now records per row whether a wrapper is
    browser-callable, rather than dropping it and losing the parameter-name guard (m) exists
    for. `anon` is still refused everything, without exception.
  - **Concurrent-session discipline.** `machines/actions.ts`, `(app)/layout.tsx` and both
    dictionaries carry another session's in-flight work, so each commit staged ONLY its own
    hunks, built from HEAD and typechecked in place first, because "it compiled in the
    working tree" is a statement about a different file. HEAD's layout had to be typechecked
    against HEAD's `nav.tsx`, since that session's `MoreMenu` has already moved to a `groups`
    API.
  - Gates green throughout: 228 TS tests, typecheck, lint, `design:lint`, `errors:check`,
    i18n parity (**3 950 leaf keys**).
  - **Still to build**: the public sign-up route itself (plan picker, vehicle count, live
    price, details form, `/activate` and everything behind it exists and is proven, but
    nothing creates the pending farm yet); self-serve "change plan" and "add vehicles" on
    `/billing`; the dormant-pending sweep on the nightly cron; the receipt PDF redesign; and
    audit items S9/S10/S12. **Needs a founder decision**: when Rapid Rise refunds a farm,
    does the plan end immediately, at period end, or not at all? The alert fires today and
    nothing moves.


- **The front door, slots a farm buys, a declined first payment that opened the app, and a
  receipt that read like an invoice** (migrations `20260911120000`, `20260911140000`,
  `20260911160000`; commits `78c65d8`/`111def1`/`efa4bef`/`ec99872` on `main`; every
  migration applied to production from disk and each behaviour driven against the live
  database inside a rolled-back transaction):
  - **A farm can now sign itself up** (`20260911120000`). `/signup` sits in `(public)` with
    **zero anon DB access**, the plan prices come from `entitlements.ts`, not a query, and
    `app.create_pending_signup` writes the farm, the owner, a `pending` subscription and the
    first invoice in ONE transaction, so a half-made farm cannot exist. The generator's
    pending arm is deliberately narrow: a `pending` subscription is admitted **only while it
    has no invoice at all**, so somebody who opened the page and walked away does not
    accumulate a monthly invoice for ever.
  - **Farms buy vehicle SLOTS; the product had been counting them** (`20260911140000`).
    `pending_quota`/`pending_quota_on` plus `app.billing_quota_change_quote` and
    `app.change_billing_quota`: buying more slots is charged immediately with proration, and
    giving slots back takes effect at period end, the direction that costs the customer
    money is the one that waits. Slot purchases needed their **own invoice `kind = 'slots'`**
    because two of them in one period collide on `billing_invoices_proration_uq`'s
    `(farm, period, plan)` key. `/billing` gained `changeOwnPlan` and `changeVehicleSlots`,
    so an owner no longer has to ask Rapid Rise to change either.
  - **The dormant sweep, and a plpgsql trap that made it dangerous.**
    `app.sweep_dormant_signups(p_days default 7)` clears sign-ups that never paid. Its
    `not exists` guard referenced `s.id`, the LOOP's record variable, inside the query that
    FEEDS the loop. plpgsql substitutes NULL there, so the guard passed for everybody and the
    sweep took a **paid** sign-up. Caught by suite section (y), not by reading; fixed to
    `billing_subscriptions.id`.
  - **A declined first payment opened the farm (S10).** `billing_register_failure` moved a
    `pending` subscription to `past_due`, and `app.farm_billing_gate` reads anything but
    `pending` as "let them in", so failing to pay was the way IN. Two independently
    plausible pieces, each correct alone. Guarded in `20260911160000`, with S9
    (`seller_snapshot`/`bill_to_snapshot` added to the invoice freeze list, so a receipt
    reprinted next year cannot be restated) and S12 (the rollup reordered to test
    `status = 'draft'` first).
  - **S12's finding was half wrong and the migration says so.** The audit claimed a
    zero-total invoice could never reach `paid`; `billing_payments_nonzero_ck` forbids a zero
    payment, so the rollup never runs on one. The header records the correction rather than
    leaving the claim standing, and the assertion moved to the case that IS reachable, a
    draft invoice flipping to paid.
  - **`src/lib/security/bearer.ts`**, both cron routes compared their bearer token with
    `===`. Now hashed and compared with `timingSafeEqual`; hashing first because
    `timingSafeEqual` throws on unequal lengths, and the length is itself a leak. 8 tests.
  - **The receipt PDF** (`ec99872`). It answered neither of the two questions somebody opens
    a receipt for: the total was a `kv` row eight down, carrying the same weight as the
    payment reference, and nothing said PAID except the word "Receipt". The amount and
    "Paid in full" now lead in a `totalBlock`, with the itemisation under "What this covers".
    The engine's default brand green was `rgb(0.08, 0.5, 0.24)`, ≈#14803D, a green in no
    token file and nowhere in the app, so **every FleetWise-branded PDF has been printing
    off-brand**; corrected to #00572C. Only the fallback moved; a partner's own colour is
    untouched.
  - **Two receipt defects that only the rendered BYTES could find.** `VAT (15%%)`, in both
    languages: `vatPercent()` already returns "15%" and the template appended a second sign -
    the only site in the codebase that does, and a doubled `%` is a valid string. And the
    footer stamped `FleetWise · generated 2026-09-11` under a page translated everywhere
    else; it now supplies its own footer through the engine's `brand.footer` hook, leaving
    partner letterheads and job cards alone. **"Generated", not "issued"**, the engine
    stamps TODAY, so a reprint next year must not claim that as the issue date.
  - **The reader was broken in a way that looked exactly like a broken document**: 35
    assertions failing across six receipts. Not compression, the streams ARE deflated and
    `inflateSync` succeeds. This engine EMBEDS its fonts, so pdf-lib writes **hex strings**
    (`<466C…> Tj`) rather than the parenthesised literals a standard-14 font gets. A related
    near-miss: the em and en dashes appeared to be missing from every receipt; they are not -
    `0x97`/`0x96` are those dashes in WinAnsi and `sanitize()`'s `EXTRA` set keeps them on
    purpose. Checking the code points before "fixing" the engine avoided breaking something
    that works.
  - **`server-only` must not be stubbed in `node_modules`.** The rig needed the marker
    resolvable outside Next and a local stub was the obvious fix; it is the wrong one.
    `server-only` exists to FAIL a build when server code reaches a client bundle, and this
    codebase keeps a service-role key and a Paystack secret behind exactly that line. It is
    also not an installed package (Next resolves it through its own bundler alias), so a stub
    is undeclared, unversioned and wiped by the next `pnpm install`. The substitution now
    lives in a **loader** beside the script. Both layers have to be patched: tsx transpiles
    TypeScript to CommonJS, so the ESM `resolve` hook never sees the specifier and only the
    `require` path does, registering one looks like it works until the import happens.
  - **Refund policy, decided by the founder (11 September 2026), written up as `BILLING.md`
    §11b.** There is no refund control in the product and there is not going to be one: a
    refund is made through Paystack by whoever handles the support request. A refund the
    customer **asked for** cancels the subscription immediately; a refund Rapid Rise issues
    because **something broke** is on us and the farm keeps its subscription. FleetWise
    cannot tell the two apart from a webhook, so nothing is automatic, `refund.*` raises a
    `billing_refund` alert to Rapid Rise and a human decides.
  - Mutation-tested throughout, controls included: the receipt rig puts back the doubled
    percent, the untranslated footer and the duplicate total and requires each assertion to
    fire, with a reworded-comment control that must survive.
  - **"It typechecks" was a statement about a file that is not in the repo, and `main` was
    broken for a while because of it.** `efa4bef` shipped a nightly cron reading
    `push.error` and `push.deferred` off `deliverPush`'s result; neither field is on the
    COMMITTED `DeliverResult`, both exist only in the concurrent session's uncommitted
    rework of `src/lib/push/deliver.ts`, which was sitting in the working tree when the gate
    ran. Three errors, invisible here, fatal on Vercel. Found by checking out the pushed
    commit into an isolated worktree and typechecking THAT; fixed in `dd15916` with field
    names present on both shapes, so it keeps compiling when that session lands its rework.
    **Second occurrence this month**, the rule is now unconditional: in a tree carrying
    another session's work, a gate only counts in a clean checkout.
  - That checkout also gave the real build numbers: typecheck clean, lint clean, `next build`
    green, shared first-load JS flat at **102 kB**. i18n EN/AF at parity (**3 983 leaf keys**
    in the committed blobs). Both dictionaries and several app files still carry the other
    session's in-flight work, so every commit staged only its own hunks, built from HEAD via
    `git hash-object -w` + `git update-index --cacheinfo`.
  - **A second mixed-line-endings file.** `src/app/api/cron/nightly/route.ts` held 140 CRLF
    lines and 8 LF ones, exactly the block a script had appended, so the first repair
    attempt matched nothing. Same hazard already recorded against
    `supabase/tests/billing_subscription.sql`. The exactly-once anchor guard reported it
    instead of editing the wrong place; the file is uniform again.
  - **Every open item from the billing audit is now closed** (S1-S12). **Still not done:**
    none of `/signup`, `/activate` or the new `/billing` controls has been opened in a
    browser; a Paystack refund or dispute raises an alert but **moves nothing in the
    ledger** (no negative-payment model on the SaaS side, the partner side has one at
    `0422` and the SaaS side could follow, but it needs a decision about what a part-refund
    means for a period already supplied); and the **Starter Business R80,000 lifetime
    collections cap** still has to be cleared, the founder upgrades the Paystack tier at
    R10,000 collected.


- **The first browser pass over the sign-up front door, and the five things reading had
  missed** (commits `dd15916`/`5003d2b`/`0b5da35` on `main`; no migration; every screen
  driven against the live database from a local production build):
  - **The gap this closes** is the one the previous block named: `/signup`, `/activate` and
    the new self-serve controls on `/billing` had shipped without any of them being opened.
    Everything this project has learned says that is where the defects are, and it was right
    again, **five real ones, none of which any gate can see**. Typecheck accepts every
    string in question, `i18n:parity` compares EN to AF and both were equally wrong,
    `errors:check` is about error codes, the build succeeds, and two of the five are
    invisible in a screenshot because they live in the accessibility tree.
  - **`/activate` printed `errors.billing-unavailable` at a customer about to pay.** It
    hand-rolled `t("errors." + code)`; `t()` returns the key on a miss and the catalogue
    spells it `errors.billingUnavailable`. The sentence already existed and already said the
    right thing, *"Card payments are not switched on at the moment. Nothing has been
    charged."*, and was simply unreachable. Routed through `errorMessage()`, the shared
    resolver that exists so a code never reaches a screen, which is what `/billing` has done
    since it shipped. The twenty billing codes mapped after the dead-button episode now
    reach the one screen a paying customer sees.
  - **A placeholder that does not match its call site is rendered verbatim**, and this
    product substitutes every one by hand. `/billing` showed a paying farm
    **`Expires {month}/{year}`** under their card number, because the code passes one
    already-formatted value as `{expiry}`. Sweeping all 464 source files found four more:
    `adminBilling.retryDialogTitle` is *"Charge {farm} now?"* and the code replaced
    `{amount}`, so **a Rapid Rise admin about to take money off a customer's card was asked
    to confirm "Charge {farm} now?"**; `billing.vehiclesNotCounted` was the bare words "Not
    counted" while the code handed it `{n}` and `{total}`, so a farm with retired vehicles
    read that under a number with nothing relating the two; and `retryIntro` plus
    `reducedNote` carried five dead replaces between them. Two shapes, opposite fixes, fix
    the SENTENCE where the code had real values and nowhere to put them, fix the CODE where
    it substituted into a sentence with no such slot. Dead replaces were deleted rather than
    given slots, because inventing copy in two languages to justify dead code is the wrong
    way round.
  - **The sweep is the durable part**, mutation-tested 3/3 with a clean control, and one
    mutation earned its keep: the first version skipped any key rendered with **no**
    `.replace()` at all, which is the likeliest way a raw `{slot}` reaches a customer, and
    a mutant walked straight through it. Those are now a short check-by-hand list (five
    sites, all verified, all a key handed to a component). Two earlier versions of the
    checker were themselves the bug: `.replace\([^)]*\)` ends at the inner `)` of
    `String(steps.length)` and reported 23 mismatches, most of them its own; and a `t()`
    inside a parenthesised ternary needed crediting with the chain hung off that expression.
    **A checker that cries wolf stops being read**, so the parsing has to be at least as
    careful as the thing it checks.
  - **The plan chooser told a screen-reader user it was called "You will pay."** Its
    `sr-only` legend was `labels.total`, and the Monthly/Yearly pair had no group name at
    all. Both named now, in both languages, and read back out of the accessibility tree
    rather than assumed, an invisible label is the one thing a screenshot can never check,
    which is exactly how the wrong one survived.
  - **What was proven correct**, because a browser pass that only reports faults is half a
    measurement: 24 plan × period × vehicle-count combinations render the exact figure,
    including the ten-month annual rule and the hidden fields that actually post, with
    mutants firing at exactly the right counts (12 for the annual rule, 6 for one plan).
    Sign-up writes farm, owner, pending subscription and first invoice in ONE transaction -
    `FW-2026-000006`, R292,00 for 4 × R73, VAT 0, gate `pending`, and **the figure on the
    screen and the figure in the ledger agree**, which is the S3 class of defect not
    happening. Six guarded routes all bounce to `/activate`. Thirty-two repeated presses of
    Pay left 32 attempts, all settled `abandoned`, none stuck.
  - **Four of my own measurements were the defective thing**, which is most of what this
    cost and the most transferable part. A probe that gave up at 3,500 ms reported the error
    as never shown, 10 times out of 10, when the action takes ~4,300 ms, and on that false
    premise I added `export const dynamic = "force-dynamic"` with a confident comment
    explaining a cause that was not the cause. Measured with and without: it changes nothing,
    so it and its rationale are gone rather than left in the codebase looking like an
    explanation. A blank screenshot that looked like a fatal render was a mid-transition
    frame. A follow-up check reported "message not shown" because a heredoc had eaten a
    backslash and `/s+/g` deletes every "s" in the page text. And the tap-target check
    opened with six findings, all false: a 20px radio inside a 102px `<label>` is a 102px
    target, and WCAG 2.5.8 exempts a link sized by the line-height of the sentence around it.
  - **`efa4bef` had left `main` unbuildable for Vercel** and the working tree could not see
    it: the nightly cron read `push.error` and `push.deferred`, fields that exist only in a
    concurrent session's uncommitted rework of `src/lib/push/deliver.ts`. Second occurrence
    this month, so the rule is now unconditional, **in a tree carrying another session's
    work, a gate only counts in a clean checkout.** Fixed in `dd15916` with field names
    present on both shapes, and every commit since verified in an isolated worktree at the
    pushed SHA: typecheck clean, build clean, shared first-load JS flat at **102 kB**.
  - **Production was written to and put back.** The test farm, its owner, subscription,
    invoice and 42 attempts were removed in one transaction; `billing_invoice_ref_seq` was
    rewound from 6 to 5 so the numbering carries no gap for a document that no longer
    exists. The freeze trigger refused the first attempt, **an issued invoice's lines are
    immutable, which is S9 doing its job**, so the cleanup suspends triggers for its own
    transaction only, as `postgres`, and still commits or rolls back as one. Afterwards:
    2 farms, 15 auth users, 5 paid invoices totalling R1 095,00, exactly as before.
  - Also fixed: `src/app/api/cron/nightly/route.ts` had 140 CRLF lines and 8 LF ones -
    exactly the block a script had appended, the same mixed-endings hazard already recorded
    against `supabase/tests/billing_subscription.sql`, and the reason a repair anchor matched
    nothing. The exactly-once guard reported it instead of editing the wrong place.
  - **Still not done**: the self-serve `changeOwnPlan` and `changeVehicleSlots` were rendered
    and their forms verified wired (fields, labels, submit words), but **not pressed**, both
    write to the billing ledger of the demo farm and an upgrade raises a proration invoice
    that, correctly, cannot then be cleanly removed. Their arithmetic is proven in SQL inside
    rolled-back transactions; pressing them wants a throwaway farm. A Paystack refund or
    dispute still raises an alert and **moves nothing in the ledger**. And the **Starter
    Business R80,000 lifetime cap** is still ahead of us.


- **Everything before a farm can use the product: the door closes, the account is yours, and
  the paperwork exists** (migrations `20260911180000`, `20260911190000`, `20260911200000`;
  commits `4777bf6`/`23401a4`/`901a189`/`cb09a8f` on `main`; every migration applied to
  production from disk, every screen driven in a browser):
  - **The question was "what still has to be built before a stranger can sign up and pay",
    and the answer began with a revenue leak.** `app.farm_billing_gate` blocked exactly one
    state, a subscription that exists and is `pending`, and answered `ok` to everything
    else. The lifecycle engines around it were already complete: `billing_close_cancellations`
    moves non_renewing to cancelled at period end, `billing_apply_downgrades` moves grace to
    downgraded and drops `farms.plan`. **Both terminal states then answered `ok`.** So a farm
    that stopped paying kept the product on Essential for ever, a farm that cancelled kept
    all of it, and `farms.status` ('suspended'/'cancelled') was read by no policy, no helper
    and no layout. The only customer the product ever refused was one who had never paid.
  - **One more gate state, not a read-only mode.** Letting a lapsed farm browse but not write
    means every one of ~200 server actions has to check, and one missed action is a write
    path into an account nobody is paying for, F7 exists in this codebase because UI-only
    enforcement is not enforcement. One screen can be proved correct; two hundred guards
    cannot. So `closed` sends every app route to `/closed`, and the promise "nothing is
    deleted" is kept by `/api/farm/export` instead: the whole history as one JSON file,
    reachable precisely BECAUSE it sits outside the gated layout. Every read there goes
    through the caller's own client with no hand-written `farm_id` filter, so scoping stays
    RLS's job and a table added later cannot leak by omission.
  - **`lapsed_grace_days` is a SETTING** (default 30) beside the retry offsets, so the
    commercial policy changes without a migration, including a very large value, which
    restores the old never-close behaviour exactly. The mutation that bakes 30 into the
    function passes every other assertion, which is why one exists.
  - **Reopening reuses the path that works.** It produces a PENDING subscription with an
    invoice, the exact state a fresh sign-up is in, and sends them to `/activate`. No
    second payment route to keep correct. It MUST clear `ended_on`, and that is the sharp
    edge: `billing_restore_after_payment` refuses any subscription carrying it (S5, and
    rightly, an in-flight charge landing after a cancellation must not resubscribe
    somebody). A reopen that left it set would take the money and leave the door shut, which
    is worse than offering no reopen at all.
  - **Nobody could change their own password.** The only `updateUser` call in the codebase
    was the admin path on the team screen. Combined with password recovery BEING the magic
    link, and with `/signup` creating the auth user `email_confirm: true` so the address was
    trusted on sight, one typo meant no receipts, no dunning warning, and a lockout only
    Rapid Rise could undo. `/account` now does name, email and password, and verification is
    ours rather than Supabase's, holding the user unconfirmed would stop them signing in,
    and `signUp` signs them in to pay. It gates nothing; it prompts. Only the SHA-256 of the
    token is stored, because `public.users` is readable by the rest of the farm and RLS
    filters rows, not columns, the `authorization_code` lesson, applied before it bit.
  - **A link in an email must never be built from a request header.** New `siteUrl()` reads
    configuration only and returns null rather than guessing: a forged `Origin` would have us
    email a victim a link to another domain, over our name, from our verified sending
    address. That is a phishing email we wrote ourselves.
  - **`errors:check` could not see most of what it guards.** It scans for a literal
    `?error=<code>` and skips anything interpolated, but the common shape here is a
    `bounce()` helper that interpolates, so every code in billing, admin-billing, activate,
    closed and account was invisible. Proven by injecting an unmapped code and watching it
    report "Clean". Widened, it sees **150 codes instead of 107** and immediately found four
    that resolved to nothing: `signup-plan`, emitted twice on the product's own front door,
    and three raw English sentences used as codes in `fuel/actions.ts`
    (`bounce("Enter a tank name")`) which fell through to the fallback, so the sentence the
    author wrote was the one thing nobody ever read. Its first widening was wrong the other
    way, counting the operands of a comparison as emitted codes and inventing six errors that
    cannot happen; a checker that invents work stops being trusted.
  - **`scripts/error_coverage.mjs` and `scripts/design_lint.mjs` are UNTRACKED.** Never
    committed, not on `main`, not in CI, and their `package.json` entries are uncommitted
    too, while this file describes both as shipped gates. My widening of the first is left
    in the working tree for whoever owns that branch; the four code-side fixes it found are
    committed. `i18n:parity` is committed and does run.
  - **Terms and a privacy notice, written from the code rather than at it.** There were none
   , no `/terms`, no `/privacy`, nothing referenced from the sign-up form, nothing recorded.
    Every clause now describes something the software actually does: the lapse window from
    `farm_billing_gate`, "nothing is deleted" from the export route, the refund position from
    BILLING.md §11b, 99.5% from BACKUP.md, the sub-processors from POPIA.md. Five of those
    clauses are asserted against the rendered page, so a drift between the wording and the
    product fails a test. **The contract is the one string in this product that is
    deliberately not a translation key**, a translated clause is a second document that can
    disagree with the first, and "which version binds" is the question nobody wants to answer
    in front of a magistrate.
  - **The tick is enforced on the server and the VERSION travels with the form**, so what is
    recorded is what the page rendered rather than whatever is current when the submit lands
   , and it is validated against what we publish, because storing an arbitrary string
    somebody typed into a form is not a record of anything. Existing accounts are deliberately
    NOT backfilled: stamping "accepted" onto fourteen rows created before any terms existed
    would record a consent nobody gave.
  - **Two more places where the server did its part and the screen never rendered it.** The
    receipt PDF was reachable only from `sendDueReceipts`, so it existed in exactly one place
   , an email, and a bounce left the customer with no way to get the document their
    bookkeeping needs. And `/api/billing/callback` computes a careful four-state outcome and
    redirects to `/billing?checkout=<state>`, which **`/billing` has never read**: somebody
    who had just handed over a card was told nothing at all. Both fixed; the second is the
    same shape as the `/activate?error=` defect found earlier the same day.
  - **A file endpoint must refuse, not redirect.** Both new routes used `requireProfile()`,
    which redirects, measured with curl, an unauthenticated receipt request answered
    `307 -> /login`, so anything following redirects would save the HTML login page as
    `FW-2026-000005.pdf`. No data ever reached an anonymous caller; it is about giving an
    honest answer, and it is the rule the VAT routes already set. My own first check called
    it "SERVED, WRONG" because it only read the status after following the redirect.
  - **Proof.** 32 SQL assertions against the live schema inside a rolled-back transaction,
    with the two real production farms asked first and last, "both still read ok" is what
    catches a gate change that locks out the customer base. Mutation-tested 7/7 with a
    surviving control, and three of those runs found faults in the HARNESS rather than the
    code: a fire detector that missed `FAIL same row, window set to 3650 days` because it
    anchored the label straight after FAIL; a dropped connection counted as seven catches
    because any `ERROR:` read as a fire (there are three outcomes now, and "the suite did not
    run" is one of them); and a mutant that survived twice, first because the probe never
    loaded the migration being mutated, then because the fixture had no stale period for the
    bug to reuse. Then 76 browser assertions across four drives: the gate, the account, the
    paperwork and the checkout states.
  - **Production was written to and put back each time.** Test farms, owners, subscriptions,
    invoices and attempts removed in one transaction; `billing_invoice_ref_seq` rewound so the
    numbering carries no gap for documents that no longer exist. The freeze trigger refused
    the first cleanup, an issued invoice's lines are immutable, which is S9 doing its job -
    so the cleanup suspends triggers for its own transaction only, as `postgres`. Afterwards,
    every time: 2 farms, 15 auth users, 5 paid invoices totalling R1 095,00, sequence at 5.
  - 159 migrations apply to a fresh database. Every commit verified in an isolated worktree
    at the pushed SHA: typecheck clean, build clean, shared first-load JS flat at **102 kB**.
    i18n EN/AF at parity (**4 085 leaf keys**).
  - **Still needs the founder, and only the founder**: decide `lapsed_grace_days` (it is live
    at 30 and it will close accounts); have a lawyer read `src/lib/legal.ts` and then bump
    `TERMS_VERSION`; set `RESEND_API_KEY`/`EMAIL_FROM`/`NEXT_PUBLIC_SITE_URL` in Vercel
    Production (verification refuses to send without the last one, rather than emailing a
    broken link); and clear the Paystack **Starter Business R80,000 lifetime cap**. Written
    up as §9 and §10 of `docs/PAYSTACK_GO_LIVE.md`.
  - **Still never done**: a real Paystack DECLINE (test mode accepts every valid stored
    authorization, so it needs a declining card through hosted checkout in a browser); the
    billing cron firing on Vercel's own schedule rather than by hand; and a refund or dispute
    moving anything in the ledger, both still only raise an alert.


- **Four things the system knew and never said, the gates that were not in the repo, a cron
  that could not be observed, and the first real Paystack decline** (migration
  `20260912120000`; commits `8a3c6ec`/`b2eef40`/`c53bba1` on `main`; every commit verified
  in an isolated checkout at the pushed SHA, shared first-load JS flat at **102 kB**):
  - **Password reset.** Recovery here has been the magic link, which works and is arguably
    better, it gets you in whether or not you remember anything, but nobody looking for
    "forgot password" found a button and nobody was told a password can be set once you are
    in. `sendPasswordReset` lands on `/account`, where the password form already lives, so
    there is no second screen and no second place for "at least 8 characters" to be written
    down. The redirect target is built from CONFIGURATION, never from the request's
    `Origin`: this URL goes in an email, and a forged Origin would have us send a victim a
    link pointing at somebody else's domain, over our name, from our verified sending
    address. The confirmation is worded so it is true whether or not the address exists -
    "no account with that address" on a reset form is an account-enumeration oracle, and
    `/account?reset=1` now says why they are there.
  - **The card-expiry warning, mirroring the SQL rather than forming a second opinion.**
    `app.billing_cards_expiring` has enqueued a notification since `20260909120000`, so the
    system has known for up to 45 days, while `/billing` said only "Expires 12/30" in grey.
    A fact, not a warning, and a card that lapses walks a paying farm down the entire
    dunning ladder as though they had refused to pay. `cardExpiryState` copies the engine's
    45-day horizon, its end-of-the-printed-month reading of "12/28", and all five of its
    silences, including "only the card the subscription would ACTUALLY be charged on"
    (`default_payment_method_id`, which every charging shortlist joins on;
    `billing_payment_methods.is_default` is a display flag and is not that). Warn, never
    block. `view.test.ts` pins the arithmetic on a FIXED date, section (o) was date-flaky
    for want of exactly that, and the TypeScript was run against
    `app.billing_card_expiry_on` itself, extracted from the migration rather than retyped,
    over **182 (month, year) pairs: 182 agree, 0 differ**, with a control proving the rig
    could see a difference.
  - **The bill you can download before you have paid it.** The only document a farm could
    get was a RECEIPT, and that route refuses anything not `paid`, correctly, because it
    says "Paid in full". But the document a bookkeeper needs in order to GET a bill paid
    existed nowhere: not on a screen, not in an email, not at all. One builder with a
    `kind`, the F14 decision for the F14 reason, two builders would be two places for the
    VAT rule (Rapid Rise is not registered, so nothing may be headed "Tax invoice",
    s20(4)) and two for the frozen-snapshot rule. It refuses `draft` (never issued) and
    `void` (withdrawn), and deliberately does NOT refuse `uncollectible`: that is a real
    debt written off in our books, not forgiven. **16 documents rendered and the bytes read
    back**, unpaid, overdue, part-paid, settled, over-refunded, no terms, no contact
    address, both languages, both VAT positions, and because the two documents now share a
    builder, the six RECEIPT cases were rendered through HEAD's builder and this one and
    compared on the inflated content streams: **all six identical**, with a control (a
    receipt against its own invoice) proving the comparison can see a difference.
  - **Where a new customer lands.** The checkout callback sends everybody to the billing
    screen, a fair receipt and a poor welcome, since a farm that has just paid has no
    vehicles and nothing pointed at adding one. Shown only while the fleet really is empty.
  - **Three gates this file called shipped were not in the repo.** `scripts/test.mjs`,
    `scripts/design_lint.mjs` and `scripts/error_coverage.mjs` were untracked, absent from
    `main`, absent from CI, their `package.json` entries uncommitted, while the block above
    described all three as working gates. `pnpm test` did not exist for anybody who cloned
    this repo. CI now runs typecheck, test, lint, `i18n:parity`, `errors:check` and build,
    and the numbers were taken against the COMMITTED tree rather than this working one:
    190 tests, 152 error codes, 4 116 keys. (The working tree runs 245 and 4 134, the
    difference is a concurrent session's uncommitted work, and CI must be told what the
    REPO does.)
  - **`design:lint` is deliberately NOT in CI, and the reason is in the workflow beside
    it.** It reports 0 violations here and **302 against the committed tree**, because the
    Official Colour Palette overhaul it was written for has never been committed. Wiring it
    in today would fail every push, and a new gate that fails on every push gets switched
    off rather than read. The script is committed anyway: a rule set that exists only in one
    machine's temp directory protects nothing.
  - **"Did the billing cron run last night?" had no answer** (`20260912120000`). Measured
    first: the NIGHTLY pass is provably firing on Vercel's schedule, **90 `notifications`
    rows in the 03:00-03:59 UTC window across 14 distinct days**, most recently 2026-09-07 -
    but only as a side effect of those engines happening to WRITE something. The BILLING
    pass writes nothing when nothing is due, and its entire output is a JSON body returned
    to Vercel's scheduler, which is read by nobody. So a billing cron that had fired every
    night for six weeks and one that had never fired once produced IDENTICAL evidence: all
    six invoices on production were raised by hand, at 11:35, 15:37, 19:39, 21:31 and 21:39
    UTC, and so was every charge attempt. `cron_runs` records one row per invocation,
    opened when the pass STARTS (a pass killed by the function timeout is the one worth
    knowing about), readable by Rapid Rise and writable by nobody with a browser (a forged
    clean run history is the one lie this table exists to prevent), distinguishing a manual
    run from a scheduled one ("it works when I run it by hand" is the answer that hides a
    stopped schedule), pruning itself at 180 days, and unable to break a pass, both calls
    swallow their errors, because telemetry that can stop the thing it watches is worse than
    none. `/admin/billing` grows a panel with four states; "has not run" is 36 hours rather
    than 24 because Vercel fires a daily cron within its hour. Suite section **(aa)**,
    mutation-tested **6 of 6 with a surviving control**.
  - **THE FIRST REAL PAYSTACK DECLINE.** Listed as "still never done" since the day billing
    shipped. The instrument turned out to be far better than the card numbers a search
    suggests: Paystack's TEST checkout renders three NAMED outcomes, Success / Bank
    Authentication / **Declined**, so the decline is Paystack stating the result rather
    than anyone inferring it from a PAN. It needs a HEADED browser; headless is stopped by
    their Cloudflare check, which is what beat an earlier session. Measured both ways on a
    R1.00 throwaway first: Declined gives `status: failed, gateway_response: "Declined"`,
    Success gives `status: success`.
  - **Then S10 driven end to end on production with the product's own code.** S10 is the
    worst defect this billing system has had, `billing_register_failure` moved any
    subscription to `past_due`, and `app.farm_billing_gate` reads anything but `pending` as
    "let them in", so for a new customer FAILING TO PAY WAS THE WAY IN. It was guarded in
    `20260911160000` and verified only in SQL, in a rolled-back transaction, with the
    failure written by calling the function directly. Now: `create_pending_signup` →
    `beginCheckout` → a real decline in a real browser → `reconcileStuckAttempts` (the path
    that runs when a webhook goes missing). **Every assertion held**: the attempt is
    `failed`, **0 payment rows**, the invoice still `open` at 0 paid, the subscription
    **still `pending`**, **the gate still `pending`, the door stayed shut**, the failure
    still counted (`failed_attempt_count = 1`), and no dunning ladder started, because a
    pending sign-up has nothing to dun.
  - **Three of my own measurements were the broken thing, which is most of what this cost.**
    `create_pending_signup` returns the SUBSCRIPTION id, not the farm, read off the
    migration's `return v_sub` only after a run reported "subscription undefined, invoice
    undefined, gate null", which looks exactly like a broken sign-up and was a broken TEST
    (`signup/actions.ts` is unaffected; it ignores `data`). `public.farm_billing_gate`
    answers NULL for a caller with no farm access, which a service-role call is every time -
    correct for a wrapper a browser uses, and useless as an assertion, so the unscoped
    engine is asked over a direct connection. And `reconcileStuckAttempts` waits 15 minutes
    before calling a pending attempt stuck, so it reported `checked: 0` against one ten
    seconds old; the drive passes `stalePendingMinutes: 0` rather than calling a different
    function, so the shortlist, the reconcile and the settle are all the shipped ones.
  - **Production written to and put back, three times.** Each run's farm, owner,
    subscription, invoice, lines, snapshot, attempts, notifications and audit rows removed
    in one transaction with triggers suspended FOR THAT TRANSACTION ONLY (an issued
    invoice's lines are immutable, S9 doing its job), the auth user deleted, and
    `billing_invoice_ref_seq` rewound so the numbering carries no gap for a document that no
    longer exists. Verified afterwards: **3 farms, 15 profiles, 16 auth users, 2
    subscriptions, 6 invoices totalling the same R1 095,00, 8 attempts, 6 payments,
    sequence at 23**, and zero rows matching the test names.
  - Gates green throughout: typecheck, lint, 245 TS tests (9 new), `design:lint` 0
    violations, `errors:check` clean at 152 codes, i18n EN/AF at parity (**4 147 leaf
    keys**). 162 migrations apply to a fresh database.
  - **The one item deliberately NOT built: landing the palette overhaul.** It is not four
    files. `design:lint`'s 302 violations come from `tailwind.config.ts`, `globals.css`,
    `manifest.webmanifest` and `layout.tsx`, but the work those rules exist for spans ~30
    more (13 `<img>` → `<Photo>`, 10 tables, 31 error render sites, 151 type-scale remaps),
    and the tree currently holds **180 modified and 35 untracked files** belonging to at
    least two other concurrent workstreams, the offline/queue capture work and a voice
    refactor. `layout.tsx` is known to be shared with one of them. Landing the four would be
    a half-landing that makes a gate pass while its subject stays uncommitted; landing all
    180 would ship two unfinished workstreams, which is exactly what broke `main` in
    `efa4bef`. **It needs the founder to say which workstream lands first.**
  - **Still not done**: a refund or dispute still only raises an alert and moves nothing in
    the ledger; the Paystack **Starter Business R80,000 lifetime cap** is still ahead; and
    `src/app/(public)/queue/page.tsx` (untracked, another session's) renders a `ui.back` key
    that exists in neither dictionary, left alone rather than patched, because adding a key
    for someone else's in-flight feature is how fragments collide.


- **THE WORKING TREE IS EMPTY: three in-flight workstreams audited, committed and
  released** (commits `e3397e5`/`7c96e80`/`b7a798c` on `main`; nine migrations applied to
  production; every screen driven afterwards). For the first time in weeks `git status` is
  clean.
  - **What was actually sitting there.** Not "the palette". 180 modified and 35 untracked
    files holding THREE finished workstreams, the largest of which was a database security
    pass: **nine migrations and five test suites**, none of them committed and none of them
    on production. The headline among them is a live leak -
    `settings.cost_visible_to_operators` was captured, stored and rendered on `/settings`
    while being consulted by **no policy at all**, so an operator could read the entire cost
    ledger, every budget, and the purchase price, supplier and finance columns of every
    machine they could see, straight from PostgREST.
  - **Everything was measured before anything was decided.** 160 migrations apply to a
    fresh database in order; all ten suites pass together (five of them the uncommitted
    ones); typecheck, lint, 245 tests, `design:lint`, `errors:check` and parity all pass on
    the full tree; `next build` green; zero TODO/FIXME markers. The work was FINISHED, the
    reason it had never shipped was not doneness, it was coupling.
  - **The coupling, and why there is no painless order.** The app reads `*_visible`
    projections that production did not have, and the migrations REVOKE the column grants
    the deployed code was reading. Deploy first and `/dashboard`, `/fuel`, `/jobcards`,
    `/parts`, `/work`, `/contractor` and `/inbox` break; apply first and the live code
    breaks instead. The obvious fix, defer the revokes to a follow-up migration, was
    **measured and does not work**: `REVOKE SELECT ON TABLE` also clears column-level
    grants, so grant-then-revoke does not end where revoke-then-grant does. Proved on a
    three-line fixture before the plan was built on it.
  - **So the release was sequenced instead**: push, poll production until `/queue` stopped
    404-ing (a route that exists only in the new code), then apply. Pushed 02:30:27, live
    02:31:58, migrations applied and verified by 02:32:11, **a five-second window**, with
    all nine landing in eight seconds.
  - **A defect that would have blocked the release, found only by dry-running against
    production.** `20260908112728` ended with `alter role fleetwise_cost_reader … nosuperuser
    … nobypassrls`, and PostgreSQL permits only a SUPERUSER to change SUPERUSER, REPLICATION
    or BYPASSRLS, including to CLEAR them. Supabase's `postgres` is not one, so that
    migration could never have been applied to the only database that matters. It passed
    every local run because PGlite and a developer's own Postgres run as superuser: exactly
    the class of difference a fresh-database harness cannot see. The fix keeps the intent and
    strengthens it, those three attributes are now ASSERTED and the migration refuses to
    proceed if they are ever wrong, rather than quietly trying to set them.
  - **Proven on production afterwards, as two personas, inside a rolled-back transaction.**
    The operator: **0 cost entries, 0 budgets, 1 job card with 0 totals, 6 fuel draws with 0
    costs, purchase price denied**, and, as the positive control, still sees their 1
    assigned machine. The owner: **38 cost entries, 5 job-card totals, 11 fuel costs**, and
    gets `purchase_price_cents = 145000000` with supplier `Senwes` through
    `public.machine_financials`, which returns the operator **no row at all**.
  - **Three of my own instruments were the broken thing, again.** A `button[type=submit]`
    click hit the language switcher, because the EN/AF controls are submits and come first -
    so sign-in failed and every authenticated page below it "passed" at 200, since a bounce
    to `/login` also answers 200. The check now asserts the URL stayed put. A probe used the
    driver with NO assigned machine, so every count was trivially zero and it could not have
    failed. And a permission error aborts a transaction, so after the first denial every
    later probe reported "current transaction is aborted" rather than its own answer, one
    transaction per persona now, not savepoints.
  - **One assertion of mine was simply wrong and the run was right.** I asserted the owner
    could still read `machines.purchase_price_cents` directly; the migration takes that
    column off ordinary SELECTs for EVERYONE and routes authorised callers through a checked
    function, which `src/lib/cost-visibility.ts` already calls. The assertion was corrected
    to the design rather than the design questioned.
  - **Committed in three, by shape rather than by size.** The SQL alone; then the app that
    those policies were written for; then the CI change. Not further split, and the reason is
    measured: **102 files carry only palette/UI work, 25 only the security layer, and SIXTEEN
    carry two at once** because both passes edited the same twelve pages. A commit claiming
    to be "palette only" while carrying policy changes is worse history than an honest big
    one. Both of the first two commits build on their own.
  - **`pnpm design:lint` is now IN CI**, the first moment that could be honest. It reported
    0 violations against a working tree and **302 against the committed tree** right up until
    `7c96e80` landed the palette it checks for.
  - **`scratchpad/` is gitignored.** It sat untracked at the repo root holding a previous
    wave's merged i18n fragments and throwaway probe harnesses, where any `git add -A` would
    have swept it into a release.
  - **Repo == production, re-proved after the release**: **271 policies in `public` on both
    sides**, 75 tables, 8 views, and **0 objects on production that are absent from the
    repo**, the `_f14_probe` direction, the one that matters. The two apparent differences
    were confirmed as harness artifacts rather than explained away: PGlite installs pgcrypto
    and pg_trgm into `public` (68 functions) while Supabase puts pgcrypto in `extensions`,
    and the 11 `storage.objects` policies cannot exist in a build with no `storage` schema.
  - Live afterwards: every public page and all twelve authenticated screens load clean, no
    JS errors, no raw i18n keys, signed in as the real farm owner. Data intact, 3 farms,
    15 machines, 6 invoices, 6 payments.
  - **Still open**: a refund or dispute raises an alert and moves nothing in the ledger; the
    Paystack **Starter Business R80 000 lifetime cap**; and `NEXT_PUBLIC_SITE_URL`,
    `RESEND_API_KEY` and `EMAIL_FROM` in Vercel Production.


- **CI green for the first time in over a week, and `pnpm db:test` runs here at last**
  (migration `20260912140000`; commit `bcbd39c` on `main`):
  - **The RLS isolation job had been failing on EVERY commit** since at least 8 September -
    through the whole billing audit, the go-live work and the release above. Nobody could
    see why: a local run passes every suite, and the job logs need repository **admin**
    rights to download. `git credential fill` supplies the token git already uses for
    pushes, which is how the log was finally read. One line in it:
    `G18 FAIL: the filed record is named agri diesel, not the deterministic pick`.
  - **The defect.** `app.link_suppliers()` (0481) collapses every spelling of one business
    into a single supplier record and picks the canonical name with
    `min(btrim(supplier_name))`. 0481's own comment calls that a deterministic pick, and
    `min()` on text sorts by the **database's collation**, so `C` yields `Agri Diesel` and
    `en_US.UTF-8` yields `agri diesel`. Production is `en_US.UTF-8`. So is CI. The supplier
    name that ends up on a remittance advice depended on where the backfill ran.
    `20260912140000` pins the tie-break with `collate "C"`, byte order, identical on every
    database anywhere, and it keeps the capitalised spelling, which is the one that gets
    printed. Nothing already filed changes; the backfill only inserts where no record for
    that name-key exists. Body EXTRACTED via `pg_get_functiondef`, altered by one token.
  - **A real Postgres now runs here.** The zonky embedded binaries (22 MB from Maven
    Central) give a genuine PostgreSQL 16.4 **server**, but ship no `psql`, so the runner
    drives it with node-postgres, splitting SQL into statements the way psql does. Green
    under **both** collations: 161 migrations, all ten suites, on `C` and on ICU `en-US`.
    Passing under one proves nothing about the other, which is the whole lesson.
  - **Three harness traps, each of which faked a wave of failures before it was found.**
    (1) Sending a whole file as one query wraps it in ONE implicit transaction, while psql
    runs one statement at a time, and `rls_isolation.sql` has no transaction control at
    all, relying on autocommit and on session GUCs surviving between statements. (2)
    `run.sh` uses a FRESH psql process per file; reusing one connection let a failed suite
    leave `set role` active and every later suite failed with "new row violates row-level
    security policy". (3) **Roles are cluster-wide**: `drop database` never removes
    `service_role`, and the shim creates it only `if not exists`, so an earlier version of
    the harness that created it WITHOUT `bypassrls` poisoned every later run, and four
    suites "failed" because rows inserted a line earlier were invisible to the role that is
    supposed to bypass RLS.
  - **And a fifth heredoc ate a backslash**, turning `/^\s*\\[a-zA-Z]/` into a character
    class so every `\set ON_ERROR_STOP on` survived into statement one and nine suites
    "failed" with `syntax error at or near "\"`. Anything containing a backslash gets
    written with an editor, not a shell heredoc.
  - `docs/SCHEMA_DRIFT.md` gains the class an object diff can never see: two databases can
    hold byte-identical objects and still sort differently. It carries the one-line check
    (`select min(x) from (values ('Agri Diesel'),('agri diesel')) v(x)`), the ICU recipe for
    building a test database that matches production, and the three harness traps.
  - **Both CI jobs green on `bcbd39c`**; production unchanged at 3 farms / 15 machines /
    6 invoices, its one filed supplier untouched.


- **Email has actually sent, the guard that hid it for weeks is fixed, and 24 server
  modules became testable** (commits `0faedd8`/`426ec76`/`eabf53b` on `main`; CI green
  throughout):
  - **PROVEN, not assumed.** A real receipt for `FW-2026-000023` was rendered from the
    invoice's own frozen snapshot, emailed through the real `sendEmail` path, and Resend
    reports **`last_event: delivered`**. `rapidriseai.com` is verified there and matches
    `EMAIL_FROM`. Nothing on production moved to do it, the send bypassed
    `sendDueReceipts`, so no claim was taken and no row changed. "Email has never actually
    sent" had been on the open list for weeks; it is closed.
  - **Why it stayed open.** `emailConfigured()` was `Boolean(process.env.RESEND_API_KEY)`,
    and `vercel pull` CANNOT decrypt secrets, it writes the literal string `[SENSITIVE]`,
    which is perfectly truthy. So the product reported email as configured, Resend rejected
    every call, and the nightly pass stamped `receipt_sent_at` on **six invoices whose
    receipts had never left the building**. All six still read as sent, with a null error.
    `EMAIL_FROM` was never checked at all, and both senders fall back to an invented address
    on an unverified domain, a fallback that CANNOT work, which converts one loud
    configuration error into a silent per-message rejection.
  - `emailConfigProblem()` now names the fault (missing / placeholder / not a Resend key /
    not an address) and `emailConfigured()` is its boolean. The guard also lives INSIDE
    `sendEmail`, because that is reachable on its own. Six tests, opening with the literal
    `[SENSITIVE]` and closing with the positive control, without which a guard that refused
    everything would look like a pass.
  - **The nightly pass now diagnoses the deployment.** `receipts: skipped
    (email-not-configured)` became `… (email-not-configured: RESEND_API_KEY is a
    placeholder, not a key)`, recorded in the `cron_runs` ledger rather than returned to a
    scheduler nobody reads, so the next 03:20 run answers "can production email?" by
    itself. Only the internal reason strings changed; the user-facing `email-not-configured`
    CODE that `lib/errors.ts` resolves is untouched. Its two tests hand both senders a
    Supabase client that THROWS on any access, pinning that a pass which cannot send also
    does not query for work first.
  - **`server-only` no longer blocks unit testing.** It is a build-time marker Next resolves
    through its own bundler alias, so a plain node process cannot load ANY module importing
    it, **24 modules under `src/`**, every billing, email and PDF module of consequence,
    none of which could be unit-tested at all. `scripts/test.mjs` now registers a shim for
    the test process only, deliberately NOT a stub in `node_modules`, which would disarm the
    guard for the real build; both the ESM resolve hook and the CJS require path are patched,
    because tsx transpiles to CommonJS and the ESM hook never sees the specifier. **253
    tests, up from 245.**
  - **The status checklist had drifted again.** Its own header warns that an earlier revision
    marked eighteen shipped features as not started; within a fortnight three of the four
    remaining ❌ items had shipped (audit location, document packs, accounting export) and a
    🟡 still deferred a billing engine that had been charging real cards for a week. Corrected
    against the code, each line now carrying the file or migration that settles it. **Exactly
    one item is genuinely not started: FR-19.4, a self-hosted licence SKU**, which is a
    packaging decision rather than code.
  - **Still needing the founder, and only the founder**: set `RESEND_API_KEY`, `EMAIL_FROM`
    and `NEXT_PUBLIC_SITE_URL` in Vercel **Production** (the nightly ledger will now say
    plainly whether they are right); clear the Paystack **Starter Business R80 000 lifetime
    cap**; and decide what a LOST dispute does to a subscription, `charge.dispute.*` still
    raises an alert and moves nothing in the ledger, and South Africa gives roughly 48
    business hours before Paystack accepts it on your behalf.


- **CORRECTION, the Paystack Starter cap is not R80,000.** Eight entries above say the
  Starter Business lifetime collections cap is **R80,000**, and a founder decision was taken
  against that figure ("not a launch blocker at this volume, upgrade at R10,000 collected").
  Read directly from Paystack's own business-types page on 12 September 2026, the South
  African Starter limit is **ZAR 1,000,000**, and the page adds that South Africa's *Sole
  Proprietorship* variant, which is what an unregistered SA merchant actually gets, has a
  limit HIGHER than a regular Starter's. That is roughly twelve times the headroom the notes
  assumed.

  The earlier entries are left as written rather than rewritten, they are a log of what was
  believed at the time, and editing them would hide that this was ever wrong. This line
  supersedes them. `docs/PAYSTACK_GO_LIVE.md` carries the corrected figure, the upgrade
  requirements, and the one-line check against your own account, which is the only
  authoritative source: a published limit is a default and an account can differ.

- **The refund policy decided, support cases that gather their own evidence, and a Paystack
  tier that was never what the notes said** (migrations `20260912160000`,
  `20260912170000`; commits `387799f`/`d22e6cc`/`2f78fee` on `main`; CI green):
  - **Rapid Rise AI is a Paystack REGISTERED BUSINESS**, confirmed from the dashboard:
    Approved, Live, documents uploaded, director on file, ZAR payouts enabled to a Capitec
    Business account. **Registered Businesses have no collections cap**, so the entire cap
    thread in the entries above is moot. It was wrong twice over: recorded here as
    **R80 000**, published by Paystack as **ZAR 1 000 000** for a South African Starter, and
    applicable to this account in neither form. The failure was carrying a note about an
    EXTERNAL account forward instead of looking it up, **for anything that lives in someone
    else's dashboard, check the dashboard.**
  - **The refund policy, decided (BILLING.md §11b).** Money goes back only when a person
    decides, case by case. The two ordinary ways a farm pays less are not refunds and
    already happen unaided, a mid-cycle DOWNGRADE keeps the paid-for plan to period end
    then charges less, a CANCELLATION keeps access to period end and simply does not charge
    again. Both were verified against the code before being written down as policy.
  - **What is left is three cases**, "I do not recognise this deduction", "you charged me
    after I cancelled", "somebody used my card", and none can be automated, because the
    same webhook arrives for all three and says nothing about which. So each becomes a
    **support case** with the farm, the owner and how to reach them, the subscription, the
    invoice, every payment on it (refunds included, so "have we already given some back?" is
    answered before it is asked), the card, the attempt history and the vehicle count,
    gathered at open time and frozen. Idempotent on the provider's own reference, so
    Paystack's 72 hours of redeliveries refresh one case, and never rewrite evidence that
    is contemporaneous with the complaint.
  - **The deadline chase**, worth building whatever was decided: a card dispute gives roughly
    48 business hours before Paystack settles it for us and takes the money from a payout.
    The nightly billing pass chases any case whose deadline is near, at most once a day each
   , a deadline that shouts hourly gets muted, and a muted alarm is worse than none.
  - **Two defects found by RUNNING it.** A dispute webhook names a TRANSACTION, not one of
    our payment rows, so the card came back absent on the path that matters most; and the
    attempt behind that payment had no payment method anyway, because a first payment goes
    through hosted checkout, which captures the card during the transaction rather than
    charging one we hold. It now falls back to the card on file and **says which it is** -
    `source` is `charged` only when that attempt genuinely used it, `farm_default`
    otherwise. Presenting the second as the first would hand somebody an identification they
    never made, in a case that may end with a person being told their card was used without
    permission.
  - **Delivery to RapidRise OS is env-gated and RECORDED** (`SUPPORT_WEBHOOK_URL`, optional
    HMAC over the raw body). A failed post leaves the case unposted with the reason and the
    nightly pass retries; twenty failures say the integration is broken rather than flaky.
    The case is written HERE first and unconditionally, because the dispute that arrives
    during an outage is precisely the one somebody needed. `/admin/support` lists them,
    read-only, for the same reason. **RapidRise OS is not in this workspace**, so its
    receiving end is not built, the contract is in `.env.example`: one POST per case,
    upsert on `id`.
  - **Section (j) refused the new functions on the first run**, which is its whole job.
    `support_ticket_evidence` reads five billing tables and builds an object that LEAVES THE
    BUILDING, so it is granted to nobody at all, reachable only through two further doors,
    and the charging credential is absent from its column list by construction, asserted in
    the dry run rather than trusted.
  - **A new gate, `pnpm i18n:keys`, and the defect that prompted it.** `PageInfoButton`
    builds `pageInfo.${infoKey}Title` at RUNTIME, so no static sweep sees it and parity
    passes when a key is missing from BOTH dictionaries. **`/billing`, `/admin/billing` and
    `/reports/schedules` were rendering raw keys to users** in their "What is this?" panels.
    The gate checks static keys, dynamic stems and page-info keys; mutation-tested 3/3 with
    a passing control, and its first version cried wolf on nine legitimate call sites that
    use a camel-case PREFIX (`ui.statusOk`) rather than a dotted group, corrected, because
    a checker that cries wolf stops being read.
  - Verified: all ten suites on real PostgreSQL under BOTH collations; dry-run against
    production in a rolled-back transaction proving the evidence assembles from real data, a
    redelivery yields one case and the chase finds it; then applied, with RLS, grants and an
    empty ledger checked. Eight gates green in CI; build 103 kB.

---

## 2026-09-18, Billing review: the quota/counted split, the missing steps, and load

A full pass over the subscription system, sign-up to renewal, asked for as "find missed
features and mistakes". Findings were measured against the **production database**, not read
off the code, which is how the first one was found at all.

- **`/billing` was quoting the wrong price to every self-serve customer.** The page put the
  COUNTED fleet into `estimateNextCharge` while `app.generate_billing_invoices` bills
  `coalesce(asset_quota, counted)`. Proven on production: the Rapid Rise AI farm holds a
  quota of 3, runs 0 machines, and its paid invoice is **R750,00**, the screen rendered
  **R0,00**. That is precisely the number `/billing`'s own header warns is "the one wrong
  price a customer would never think to question", and every farm that signs up through
  `/signup` has a quota, so it was wrong for 100% of new customers. `billedUnits()` now
  mirrors the SQL, the vehicles card is written for slots when slots are what is sold, and
  five assertions in `view.test.ts` pin the cases, including `null` meaning "no ceiling"
  rather than "no slots", which would bill every grandfathered farm nothing. `BILLING.md`
  gains §6b, because the doc described only the metered model.

- **`listUsers()` with no pagination would have started turning customers away at 51.**
  `/signup`'s "have you been here before?" check scanned a page that DEFAULTS TO FIFTY rows,
  so it really asked "is this address among the fifty most recent users", correct at the 16
  users on production, wrong from 51, and wrong first for the oldest accounts, which is
  exactly who a returning customer is. Nothing would have failed a test; it would simply
  have begun refusing people as the business grew. Replaced with one indexed probe
  (`20260918120000`), service-role only, a wrapper `anon` could call from the sign-up page
  is an account-enumeration oracle. Soft-deleted users deliberately still read as taken,
  because GoTrue's unique index does not exclude them and `createUser` refuses either way.

- **Money-moving changes had no confirmation and no figure.** `changeOwnPlan` and
  `changeVehicleSlots` fired straight off a dropdown: one press raised a proration invoice
  and charged the card on file. Meanwhile `app.billing_plan_quote` and
  `app.billing_quota_quote` had been built for exactly this and had **no caller at all**.
  Both controls are now two-step, a GET re-prices from the subscription on every render, so
  a stale tab or a tampered value cannot put a price on screen the engine will not honour,
  and a review that is only ever a navigation can never itself take money. Every other
  destructive action in this product already went through `ConfirmDialog`; the two that
  spend the customer's money were the two that did not ask.

- **Three actions existed and were reachable by nothing.** `resumeBilling` (so a farm that
  cancelled by mistake had no way back but email), `removePaymentMethod` (so the only way to
  take a card off was to cancel), and the specific `?saved=` outcomes, the actions
  carefully report *charged now* vs *scheduled for the renewal* vs *being checked*, and
  `page.tsx` rendered one `ui.savedChanges` for all seven. `savedNotice()` is now the shared
  resolver for both billing screens; `checking` is INFO and never success, because telling
  somebody a payment went through while it is still `unknown` is how they pay twice.

- **The seconds after paying showed the pay screen again.** The callback lands on
  `/billing?checkout=paid`, which is inside `(app)`, whose layout runs a gate that is still
  `pending` until the webhook settles, so it redirected to `/activate` and dropped the
  query string. A second press was safely refused by the in-flight index, but the refusal
  reads "a payment on this bill is already in progress", which is an alarming sentence at
  the best moment in the funnel. `/activate` now reads the LEDGER (not a query parameter, so
  it is true however they arrived) and shows "payment received" or "waiting on your bank"
  with no Pay button at all, using the reconciler's own 30-minute staleness window so an
  abandoned checkout is not stranded on it for ever.

- **Nothing warned anybody before money left.** Every billing message fired on `past_due`,
  `grace` or `downgraded`, all of them about something already gone wrong. `20260918140000`
  adds a renewal notice at 3 days monthly / 14 days annual, both in `billing_settings`.
  Annual matters most: ten months of list price in one deduction, and a farmer who has
  forgotten the date reads it as fraud, which is a chargeback, and then a dispute with 48
  business hours on it. Priced from the live catalogue and SILENT when there is none,
  because a figure the generator will not produce defeats the whole purpose.

- **Load.** `runBillingCharges` ran strictly serially on a hard slice of 50, and the cron
  route declared no `maxDuration` at all while making one outbound HTTP call per charge.
  Fifty renewals on the first of the month was most of a minute of pure waiting inside a
  function whose budget was whatever the platform felt like. Now: six concurrent
  (correctness still held by the unique index, not by the loop), the shortlist reports
  `moreDue` when it comes back full, and the route DRAINS it under three bounds, a 180s
  budget that leaves room for steps 5-9, a 40-page cap, and a `claimed === 0` guard so a
  full page nobody can charge cannot spin. `maxDuration = 300` declared. Truncation is
  reported to Sentry, not just counted in a JSON body Vercel reads and nobody else.

- **Sign-up, as a thing a farmer actually uses.** A one-line blurb was the entire argument
  for R89 a vehicle over R44, so the picker now has a feature comparison DERIVED from
  `FEATURE_MIN_PLAN`, the same map the gates read, so it cannot advertise something the
  product will then refuse. Annual saving is a number (`R X a year`) rather than a claim,
  the period toggle moved above the plans because it changes every price below it, the
  vehicle count got a stepper for a thumb in a bakkie, and the total says whether it leaves
  the bank monthly or once. Also a rate limit (`20260918130000`) on what was the only
  anonymous WRITE endpoint in the product, 10 an hour per source, same bucket shape as
  `app.assistant_turn_buckets`, failing OPEN on a database error because turning away a real
  customer is worse than a dormant row the sweep removes.

- **Two documents were wrong.** `BILLING.md` §15 still said no live Paystack call had ever
  been made and the webhook had never received a real delivery; production holds six paid
  invoices and seven processed `charge.success` events (one correctly REFUSED, a probe
  carrying a reference we never minted, which is the re-verification rule working on live
  traffic). `CLAUDE.md` still listed the billing cron as never having fired on Vercel's own
  schedule; `cron_runs` shows an unbroken nightly record at 04:01 UTC. Superseding notes
  added rather than edits, per the rule.

- **Section (j) refused a grant on the first run**, which is its whole job, the new engine
  function had been given EXECUTE to `service_role` directly instead of being reached
  through its `public.cron_*` wrapper. Caught before it went anywhere.

- Verified: 166 migrations apply cleanly in order; `billing_subscription.sql` PASSES with
  the new objects; 292 TypeScript tests (12 new, covering the quota arithmetic, the outcome
  messages, and concurrent charging taking exactly one charge per invoice with outcomes
  attributed to the right farm); typecheck, lint, i18n parity (4299 keys both languages),
  i18n key sweep, error coverage, design lint all clean; production build green.
  **`pnpm db:test` still cannot run, no psql on this machine**, so `pnpm db:check`
  (`scripts/migrate_check.mjs`) was added: all migrations plus every suite on PGlite, a
  fresh database per suite. Four non-billing suites fail there on the stand-in's stubbed
  `digest()`; **the same four fail identically on a clean checkout**, which is how they were
  attributed to the harness rather than to this work.

**Left undone, deliberately:** nothing was applied to production, the three migrations are
in the repo and have not been run against the live database. Leaked-password protection is
still off in Supabase Auth (a dashboard setting, not a code change). `SUPPORT_WEBHOOK_URL`
is still unset, so a dispute's 48-hour clock still depends on somebody opening
`/admin/support`. And a real Paystack decline still has never happened.

## 2026-09-19, The money screens, for a farmer on a phone

Carried out `docs/prompts/billing-ui-ux-upgrade.md`: five UX jobs on `/billing` and
`/signup`, one commit each (`dd44caf`, `d409f9c`, `0528a49`, `243e770`, `ffa489a`), plus two
defects the work turned up (`b9ed2cf`, `c749a31`). Nothing about what is charged, or when,
moved. `actions.ts` was not touched, and no migration was written.

There is no `.env.local` on this machine, so the pages could not be rendered end to end. The
layout was measured instead with a harness in the session scratchpad. It server-renders the
REAL components (`Stat`, `Flash`, `StatusBadge`, `PageInfoButton`, `SavedMessage`,
`PlanPicker`) with the production CSS from `.next/static/css`. Headless Chrome then lays the
page out inside a fixed-width `srcdoc` iframe and posts back measurements. The iframe is
needed because **headless Chrome on Windows will not lay a window out narrower than about
500px**. The first round of "360px" figures was really 504px, which the page's own `innerWidth`
gave away.

- **The answer is above the fold.** `/billing` opens on three `Stat` tiles: the next charge
  with its date, slots used against slots bought, and the card with its expiry state. The
  next charge used to be the footer of the third card. The tiles compute no figure.
  `chargeSummary` / `fleetSummary` / `cardSummary` in `view.ts` only choose between numbers
  the page already held, and ten tests pin the choices. Three deliberate mutations of those
  choices were each caught. Two choices go beyond the brief's input list:
  - An **outstanding bill beats the renewal estimate**. A retry charges that bill's balance,
    which after a failed pro-rata charge is not the renewal figure.
  - An **attempt in flight shows "Being checked / Do not pay again"** and never an amount.

  Free slots are `greatest(quota − billable, 0)`, the same rule as
  `app.vehicle_allowance.remaining`, so the tile agrees with the vehicle-limit wall.
  Measured at 360px on a 640px phone with browser chrome (tab bar at 519px): the strip ends
  at 438px in English and 453px in Afrikaans with R12 450,00 and a 120-vehicle fleet. Two
  fixes were needed to get there. The title row wrapped its info button onto its own line
  (56px), and "120 / 150" broke across two lines in a half-width tile; the used count is now
  the big figure with "/ bought" beside it smaller. It does NOT fit in one case: a long
  "checking" banner plus a site switcher plus Afrikaans (658px). That is not the default
  view, and there the banner is the right thing to see first.

- **Reading and changing are separate.** Both change forms sit behind one native `<details>`
  with no JS. The two-step was checked mechanically: every `<form>` tag and every
  input/select, attributes and order, is identical before and after (className aside).
  `/machines/new`'s "add slots" link was `/billing#slots`. The server cannot see a fragment
  and Next's client-side scroll does not open a `<details>`, so it now reads
  `/billing?manage=slots#slots`, and `?manage=` opens the disclosure.

- **The invoice history is a card list below `sm:`, and the table from `sm:` up**, both
  rendered from one pass over the rows. Which documents a row may offer moved to
  `invoiceDocuments()`, which refuses the same cases the PDF routes do. Measured at 360px:
  links 48px tall, no page scroll.

- **Defect: billing statuses had never been translated.** `enumLabel()` builds
  `billingInvoiceStatus.open` at runtime and, on a miss, prints the raw value with
  underscores turned into spaces. None of the four billing groups existed. So both billing
  screens have always shown "open", "paid" and "past due" in English to every reader.
  `i18n:keys` cannot see a key assembled from a function argument, and the fallback looked
  plausible. It was found in the Afrikaans render of the new list. The groups now exist in
  both languages, and a test walks every value in the `LOOK` maps plus the schema's enums.

- **Defect: a voided bill read "R730,00 outstanding"** in amber beside its own Voided badge.
  `outstandingCents()` now returns 0 for `void` and `uncollectible`, the rule `partner-docs.ts`
  already applies. `status` is required, so no caller keeps the old reading silently.
  `payableInvoice()` / `retryOffer()` only ever considered open and draft bills; a test pins
  that the pay button's behaviour is unchanged.

- **The Toast primitive has its first caller.** `SavedMessage` (`components/billing`) decides
  from `savedNotice`'s tone via `savedIsTransient()`. A success is a toast fixed 15px above
  the tab bar, cleared after 10s, with a 48px dismiss. Everything else stays a `Flash`: above
  all `checking`, and any change that is only scheduled, which nothing else on the page shows
  yet. **One tone moved: `card-removed` is now success**, because the brief names it as a
  toast. Its warning (add another card) persists in the card tile, which turns amber for as
  long as it is true. It is a one-line revert if that reading is wrong. `/admin/billing`
  uses the same component. Client JS on both routes went from 977 B to 1.42 kB.

- **`/signup` compares all four plans side by side.** Each tick is
  `planAllows(plan, feature)`, the function the gates call. The feature labels were
  rewritten as short row labels because sentences made each row four lines tall. On a phone
  the plans scroll under a sticky feature column, and the chosen plan's column is scrolled
  into view when the comparison opens. The effect's arithmetic was checked on the real DOM:
  flush at 174px = 174px at 360. The cells' `sr-only` text had escaped the scroller and
  widened the whole page; the table is now the positioning context. The table narrowed from
  548px to 438px, and two plans fit side by side at 412px. `entitlements.test.ts` checks that
  every gated feature has a label in both languages (deleting one makes it fail) and that the
  ticks form a staircase.

- Verified on a **clean worktree of `ffa489a`**, installed from the lockfile: typecheck; lint;
  312 tests (294 before; 18 new); i18n parity (4347 keys, up from 4304); i18n key sweep; error coverage;
  design lint 0 violations with the 34/34 contrast contract; production build.

**Left undone, deliberately:**
- Nothing was run against a live account or in a real phone browser. The measurements are of
  the real components and CSS, not of `/billing` as served. The phone invoice list was
  measured from a copy of its markup, because it is not a component.
- `/activate` was read and not changed: none of the five jobs lands on it.
- The `?checkout=` banners stay `Flash`. They are not `savedNotice` codes, `pending` must
  persist, and `paid` sits beside the next-steps card.
- `/admin/billing` still prints a price version's status raw: a no-op comparison around line
  553 renders `p.status` in both branches. That is a staff-only screen, outside the brief.
- The disclosure does not pre-fill a refused quote's figures. "Leave it as it is" returns to
  a closed box.
- None of this is pushed. `main` is eight commits ahead of `origin/main`, and CI has not run
  on any of them.

## 2026-09-19 (later), Two leftovers built; a gap review and an offline/app plan

Supersedes two "left undone" lines in the entry above. Both are now built:

- **`9471557`.** `/admin/billing` printed a price version's status raw: it looked the value
  up in the invoice-status group and then rendered `p.status` on both branches. It now has
  its own `billingPriceStatus` group, and the enum-label test walks it.
- **`26f68bf`.** A refused quote now reopens the change section with the plan, period or slot
  count the farmer asked for, and the refusal card links to it. The two-step is unchanged:
  every `<form>` tag and field name compared identical before and after.
- Gates: 312 tests, typecheck, lint, parity, key sweep, error coverage, design lint, build.

**Written, not built:**

- **[`FEATURE_GAP_REVIEW_2026-09-19.md`](FEATURE_GAP_REVIEW_2026-09-19.md).** Every finding
  is checked in the code at `26f68bf`. The first five are traps in things the product
  already claims:
  - A mistyped or replaced meter reading can never be corrected. A decrease is refused or
    becomes a conflict, and there is no action to resolve it; the `meter_readings`
    update/delete policies have no caller.
  - The fuel issue and usage-log writes are still separate.
  - Offline capture has no fuel and no checklists.
  - A failed pre-start item raises nothing.
  - Alerts never go by email.
- **[`NATIVE_APP_AND_OFFLINE_PLAN.md`](NATIVE_APP_AND_OFFLINE_PLAN.md).** The main finding is
  that "downloadable" and "works offline" are separate projects. Server actions cannot be
  statically exported, so a wrapper alone adds no offline ability. The recommendation is to
  extend F2 with a field pack read through the user's own session, so RLS stays the only
  authorisation layer, then package for the stores with TWA / MSIX or a Tauri NSIS wizard.
  Capacitor comes only if real-device tests demand it. Vendor claims were checked
  on 19/09/2026 and are cited.

**Left undone, deliberately:** none of the gaps were built. Several need a founder decision
first, and all of them sit outside `SCOPE.md` §13 as written; that mismatch is now under
**Open, founder only** in `CLAUDE.md`. Nothing is pushed.

## 2026-09-21, Founding Farmer pricing, and four gap-review items built

Four commits on `main` (`a74c85c`, `526d9cc`, `f43d46e`, `b5f0941`), each with its own
migration, its own SQL suite registered in `run.sh`, and its own gates. Nothing pushed.

- **`a74c85c`, discounts (gap 3.3).** `SCOPE.md` §12 sells a Founding Farmer rate "locked
  for life" and the engine had no way to give one: price PINNING stops a price rising, it
  does not make one lower. Both shapes the founder asked for are built, a per-farm deal on
  `/admin/billing`, and a promo code at sign-up that is COPIED onto the subscription so the
  deal does not depend on a row somebody later edits.

  Applied in `app.billing_derive_invoice_totals`, the trigger that already computes every
  total, because three functions raise invoices and patching each is three chances to
  forget. Frozen at draft, so a deal that changes later cannot restate a paid document.

  The measured near-miss: the sign-up code had to go INTO `create_pending_signup`
  (`p_promo_code`), between creating the subscription and raising the first invoice.
  Applied from the route afterwards it would have taken effect from the SECOND period and
  the farm would have paid list price for the exact thing they entered the code for -
  invisible until a Founding Farmer read their first receipt. Mutating the migration to
  invoice first reports "the first invoice took off 0 against a gross of 35600". The
  seven-argument signature is DROPPED, not left beside the new one; section (j) counts
  them.

  `view.test.ts` pins `subscriptionDiscountCents` to `app.billing_discount_cents` case by
  case. Also fixed: the "× N months" line on `/billing` was reading the final total, which
  was the same number until a discount existed.

- **`526d9cc`, driver credentials (gap 2.3).** `licences` tracks the disc on the
  windscreen; nothing tracked the card in the driver's pocket, so AARTO would nominate a
  driver whose own licence lapsed four months ago and never say so. `/fines` now says it,
  judged on the OFFENCE DATE. First table in the schema whose SELECT is narrower than
  `has_farm_access`: owner/manager see the farm, anybody else sees their own row, linked
  workshop staff see nothing. Writes are owner/manager in the DATABASE, a driver cannot
  extend their own expired PrDP, and the suite proves it by trying.

- **`f43d46e`, incidents and claims (gap 2.4).** An accident is not a fault: SAPS case
  number, third party, excess, claim reference, settlement months later. Nightly chase on a
  lodged claim past the farm's own threshold, saying how many days it has been waiting.
  `incidents_settled_ck` refuses a settled claim with no figure and no date, because that
  row would silently shrink the "still owed by the insurer" total. Operators see only
  accidents on machines assigned to them, the third party is a member of the public.

- **`b5f0941`, depreciation and book value (gap 2.7).** `/reports/assets`, as at a date.
  The security question is the whole feature: a book value IS the purchase price with the
  years taken off, so `farm_book_values` repeats `machine_financials`' gate clause for
  clause and the new columns are not granted to `authenticated` either. Removing the cost
  gate fails section (c). Deliberately NO TypeScript mirror of the sum, the inputs are
  withheld from the browser, so mirroring would mean shipping them to the client.

**Measured, not asserted:** ten mutations across the four migrations, each run through
`pnpm db:check` against the edited file. Nine were caught with the exact sentence quoted in
its commit message. One survived and is recorded rather than hidden: the `least(months,
life)` cap in the straight-line branch is redundant against the residual floor, and now
carries a comment saying so.

**Gates, on each commit:** typecheck, lint, `pnpm test` (312 → 356), `pnpm build`, i18n
parity (4347 → 4653 keys), `i18n:keys`, error coverage, design lint 34/34. `pnpm db:check`
applies 173 → 177 migrations cleanly; `billing_discounts.sql`, `billing_subscription.sql`,
`driver_credentials.sql`, `incidents_and_claims.sql` and `depreciation.sql` all PASS.

`pnpm i18n:keys` earned its place again: it caught three `pageInfo.*` keys and a cancel
label on `/team/licences` that would have rendered as dotted paths.

**Left undone, deliberately:**
- **Nothing was run in a browser.** Every screen compiles and is in the build manifest;
  none has been clicked. The SQL is proven against a real Postgres (PGlite), the TypeScript
  against its tests, and the two are pinned to each other, but no farmer has pressed any of
  these buttons.
- **Nothing is applied to production and nothing is pushed.** `main` is now twelve commits
  ahead of `origin/main` and CI has not run on any of them. Seven migrations are in the repo
  and not on the live database: the three from 18/09 plus `20260920150000`,
  `20260920160000`, `20260921090000`, `20260921100000` and `20260921110000`.
- **Gap items still open:** 2.5 maintenance calendar, 2.6 tyres, 2.8 warranty claims, 2.9
  custom fields, 2.10 machine transfer between farms, 3.4 in-app support request, 3.5
  ownership transfer, 3.7 "what's new" and sign out other devices.
- **No promo code exists yet.** `billing_promo_codes` ships empty, which is correct, the
  Founding Farmer offer is a founder decision about how many places and at what rate, and
  inventing one would be inventing a price.
- **The discount admin form has never been pressed.** Same caveat the build log already
  carries for `changeOwnPlan`: it writes to a real subscription's ledger inputs.

## 2026-09-21 (later) - Four more gap items, the login screen, the dashes, and the first click-through

Seven more commits (`522dfb0` through `3f844ce`). Everything in this entry is APPLIED to
the live database and walked through as a signed-in user, which is new: until today
nothing built in this repo had been clicked.

### The login screen, measured rather than guessed

- **Two spinners.** `useFormStatus()` reports the FORM's state, so every SubmitButton in
  one form animated. Each button now posts its own id. The first fix was WRONG and the
  browser caught it: React strips `name` from a button with a function `formAction` and
  warns "It will get overridden", so the secondary button would silently never have spun.
  Those compare `useFormStatus().action` instead. Now a hard-won rule.
- **The appearance switch.** Measured before: pressing it moved the button 54.53px in
  English and 56.34px in Afrikaans. After: 0.00px, height unchanged at 48px. All three
  labels sit in one grid cell with the inactive two `invisible`, so it is as wide as the
  longest word in whatever language is loaded.
- **The screen.** Heading and button both said "Sign in"; "Forgot password" was a sentence
  plus an underlined button stacked below the form; the email box had a hardcoded Afrikaans
  placeholder on the English page. Now "Welcome back", a "Forgot?" on the password label
  row at a 46px target, no horizontal overflow at 360px, link centre within 3px of the
  label's in both languages.

### The dash sweep

`scripts/dash_sweep.mjs`. 517 user-facing strings across ALL FOUR dictionaries, including
`en.professional.json` and `af.professional.json` which a sweep of en/af alone would have
missed entirely and which is what a farm on the formal wording actually reads. 5,285 prose
dashes across 575 source files, plus the box-drawing banners. It rewrites rather than
deletes: clauses become sentences, lists become colons, asides become commas, in both
languages. Three defects caught while tuning: `docs/POPIA.md` became `docs/POPIA. md`,
`- None -` became `, None,`, and imperative tails produced splices.

### A migration that would have broken the live site

`20260920130000` dropped the four-argument `set_notification_prefs` the DEPLOYED build
calls and replaced it with a five-argument version whose new parameter had no default.
PostgREST resolves by name, so from the moment it ran until the next deploy every
customer's notification-preferences save would have answered PGRST202. `p_email` now
defaults. `supabase/tests/deploy_compatibility.sql` pins every call shape the deployed
build makes and refuses a second overload of any of those names.

**Eleven migrations were pending, not eight.** The three from 18/09 were already applied;
the whole 20/09 diesel, offline and email batch was not.

### The click-through

`scripts/click_through.mjs` signs in as a throwaway owner through the ordinary password
endpoint, carries the session cookies the middleware sets, and walks twenty-two screens. A
page that 500s, redirects, renders a raw i18n key, shows an em dash or trips the error
boundary fails it. Then it writes through PostgREST as that user, so RLS and every
constraint decide the outcome, and reloads the page to ask whether it shows the row.

It found a real gap on its first run: `/incidents` captured the insurer and the claim
reference, put them in the nightly chase, and rendered neither. Somebody opening that
screen to ring their broker had the days and the amount but not the number the broker asks
for.

The throwaway farm is `f0000000-...-fa01`. `node scripts/seed_test_farm.mjs --remove`
clears it. Creating an auth user by hand also needs the token columns set to empty strings
rather than NULL, or GoTrue answers "Database error querying schema" on sign-in.

### The four features

- **`acba0aa` - warranty claims (2.8).** `app.job_card_warranty_cover` judges the machine
  against the JOB CARD's date and meter reading, not against today: six weeks later "is it
  under warranty" can be no while "was it, in January" is still yes. Both bases answered
  separately, because a date and an hours limit expire independently and a farm arguing
  with a dealer needs to know which ran out. "Warranty not recorded" is amber, not "out of
  warranty". Money is EX-VAT, matching the job card. A claim cannot exceed its own repair,
  and one repair carries one live claim.
- **`7ece1a9` - maintenance calendar (2.5).** Five sources, one list,
  `security invoker` so every source keeps its own RLS. Flipping it to DEFINER makes the
  suite report an operator seeing six items instead of three: the calendar would have been
  the one screen where a driver could read a colleague's medical date. Carries no money.
  Dates are STRINGS throughout, including Zeller's congruence for weekdays, because a
  calendar built on `Date` picks up the server's timezone and nobody would ever report it.
- **`2bc8c2e` - in-app support (3.4).** Reuses the case machinery and deliberately NOT
  `app.support_ticket_evidence`, which assembles a billing dossier that leaves the
  building. The form's context is allow-listed to three keys inside the database. Five open
  per farm. `my_help_requests()` returns four columns and help requests only, rather than
  widening a policy on a table that also holds disputes.
- **`3f844ce` - tyres (2.6).** A tyre is a thing; a fitment is where it is. A rotation
  keeps ONE life: counting only the current fitment reports 3 200 hours instead of 4 000
  and would have printed 187,5c an hour instead of 150c, invisibly. Hours are never added
  to kilometres; a tyre run on both gets no rate at all.

**Measured, not asserted:** eleven more mutations across the four migrations, each run
through `pnpm db:check` against the edited file. All eleven were caught.

**Gates on the final commit:** typecheck, lint, 390 tests (312 at the start of the day),
build, i18n parity (4860 keys, from 4347), i18n keys, error coverage, design lint 34/34.
`db:check` applies 182 migrations cleanly. `notification_push_delivery.sql` fails on PGlite
identically with changes stashed, so it remains one of the four pre-existing failures.

**Left undone, deliberately:**
- **Still nothing in a browser but the login form and the appearance switch.** The
  click-through is HTTP: it proves what the server renders and what the database accepts,
  not what React does after hydration.
- **Nothing is pushed.** `main` is nineteen commits ahead of `origin/main` and CI has not
  run on any of them.
- **The test farm is still on the live database**, with two machines, a job card and
  whatever the last click-through wrote.
- **Gap items still open:** 2.9 custom fields, 2.10 machine transfer between farms, 3.5
  ownership transfer, 3.7 "what's new" and sign out other devices.
- **`billing_promo_codes` is still empty.** How many Founding Farmer places and at what
  rate is a founder decision.
- **Two `alter type ... add value` migrations now exist in the same series**
  (`20260921140000` and `141000`). Postgres refuses to use a new enum value in the
  transaction that created it, so any future enum addition needs the same split.

## 2026-09-22 - Pushed to production, and CI found three real defects

`main` pushed to `origin/main`, Vercel deployed, CI green at `e0e0775`. Thirty-four
commits went out. Verified before the first push on a pristine worktree installed from the
lockfile, which is what Vercel builds.

### What CI found that nothing local could

The push was the first time the 20/09 and 21/09 migrations reached CI, and the RLS
isolation job runs `run.sh` against REAL Postgres. `pnpm db:check` uses PGlite. Three
rounds, each revealing the next because the suite stops at the first failure.

1. **`anon` could execute eight `app.*` helpers** (`20260921160000`). `create function`
   grants EXECUTE to PUBLIC and `anon` inherits it; every helper added on 21/09 said
   `grant ... to authenticated` and none said `revoke ... from public`. Not reachable,
   `anon` has no USAGE on schema `app`, checked rather than assumed. Fixed, and the same
   assertion is now in `deploy_compatibility.sql`, which `db:check` runs.

2. **Four validations lost from the offline reading path** (`20260921170000`). The 20/09
   rewrite of `apply_offline_capture` retyped a three-hundred-line function to add fuel and
   checklists, and the `log_reading` branch came back missing `isfinite(v_date)`, the
   1970 floor, the `meter_type = 'none'` guard and the name length cap. Live since those
   migrations were applied. The function in the fix was extracted from 20260920120000
   programmatically and patched in one place, because retyping is what caused it.

3. **A farm could not log a reading between 00:00 and 02:00.** The reading's date is
   decided in SAST and was bounded by `current_date`, the SERVER's date, and Supabase runs
   UTC. In that window they are different days, so a reading taken at one in the morning
   was refused as being in the future. Pre-existing: the line is in the 20260908 original.
   Both branches now compare against `v_today`, derived in the same timezone.

### The lesson worth keeping

`atomic_offline_capture.sql` had asserted (2) since it was written, and it fails on PGlite
early on the stubbed `digest()`. So `db:check` reported that one failure and every
assertion behind it was uncovered. **A suite that fails early hides everything after it.**

And (3) only FAILS during two hours a day. CI caught it because it happened to run at
23:59 UTC, which is 01:59 SAST; every green run before that was in the morning. The new
suite therefore asserts the behaviour AND reads the function, refusing to let `v_date` be
compared to `current_date` at all. That second assertion is true at three in the afternoon.

`supabase/tests/offline_reading_validation.sql` exists to be runnable where
`atomic_offline_capture.sql` is not. Removing either fix reproduces CI's exact message
locally.

### Verified in production

`https://farming-machinery-asset-manager.vercel.app`, signed in as the throwaway owner:
22 pages rendered, 9 writes landed through RLS and appeared on their pages, 2 refusals
behaved. The login screen checks out on the live site: "Welcome back", "Forgot?" on the
password label row, one spinner marker, no em or en dashes, the hardcoded Afrikaans
placeholder gone.

`node scripts/apply_pending.mjs --dry` reports nothing pending: all 184 migrations are on
the live database.

**Left undone, deliberately:**
- **The throwaway farm is still on the live database** (`f0000000-...-fa01`), with whatever
  the last click-through wrote. `node scripts/seed_test_farm.mjs --remove` clears it.
- **Only the login form and the appearance switch have been in a browser.** The
  click-through is HTTP: it proves what the server renders and what the database accepts,
  not what React does after hydration.
- **Gap items still open:** 2.9 custom fields, 2.10 machine transfer between farms, 3.5
  ownership transfer, 3.7 "what's new" and sign out other devices.
- **`billing_promo_codes` is still empty.**
- **The other suites added on 21/09 have now run on real Postgres once and passed**, but
  only once, and `atomic_offline_capture.sql` still fails on PGlite for its original
  `digest()` reason.


## 2026-09-23 - The dash gate, and the check the sweep had quietly broken

One loose end from the previous session, closed: the sweep that took ~5,800 em dashes out
of 575 files was a one-off tool, so nothing stopped the next file written putting them
straight back. It now has a gate.

### What was added

`scripts/dash_sweep.mjs --check` reports and exits non-zero. Three arms:

- any em or en dash in a string value in one of the four dictionaries, reported by KEY,
  because that is copy a customer reads;
- any em or en dash on a line of source;
- any box-drawing comment banner that is not part of a table.

Wired in as `pnpm dashes:check`, and into the "App quality gates + build" CI job between
`design:lint` and `build`.

`.yml` and `.yaml` were added to the sweep's extensions at the same time. The only file in
the repo that qualified was `.github/workflows/ci.yml` itself, which carried three em
dashes in its own step comments.

**Mutation-tested 3/3, one per arm**, each reproducing a non-zero exit and naming the right
file, with a passing control either side.

### What the gate found on its first run

32 violations, every one a comment banner in a file written AFTER the sweep: the four
scripts and the eight screens and libraries from 21/09. Which is the case the gate exists
for, found on day one.

### The defect underneath it

The sweep had rewritten a literal em dash that was being used as DATA, not as prose. In
`scripts/click_through.mjs` the line that detects an em dash on a rendered page had itself
become `if (html.includes("-"))`, so the click-through's own detector was matching every
page with a hyphen anywhere in it, which is every page. It would have reported "em dash"
on all 22 screens forever, and a checker that cries wolf stops being read.

It is now built from its code point, `String.fromCharCode(0x2014)`, which the sweep cannot
rewrite, with a comment saying why.

The whole 522dfb0 sweep was then re-read for the same class of damage: every non-comment
line it changed in `.ts`, `.tsx`, `.mjs`, `.js` and `.sql`. The rest are all empty-cell
placeholders, which is the intended rewrite. `src/lib/banking.ts:238` looks like the same
bug and is not: it predates the sweep and is a real hyphen on a bank statement.

### Gates

typecheck, test (390), lint, i18n:parity (4860/4860), i18n:keys, errors:check, design:lint
(34/34 contrast), dashes:check, build. All green.

**Left undone:** everything on the previous entry's list is still open. Nothing on the
product itself changed here; this is tooling and comments only.


## 2026-09-23 - Forms moved off the screens and into dialogs, and the gate that proves it

A UI/UX pass over the capture screens: stop showing fields until somebody asks for them,
put a row's actions behind one button, and state values instead of rendering them inside
input boxes. Nothing was removed from any form and no server action's field names changed.

### What was measured first

Counted across the app, capture forms were revealed in four different ways and three of
them cost something:

- **Always open.** `/settings` rendered 22 input boxes; `/suppliers` its whole nine-field
  "add a supplier" card between the totals and the list; `/fuel` two cards of 8 and 6
  fields side by side above the tank balance it exists to show.
- **A URL round trip.** `/tyres` and `/incidents` revealed a row's form by navigating to
  `?check=<id>` / `?edit=<id>`, so revealing four fields cost a full server render and
  left a URL that reopened the form next time.
- **Collapsed but rendered.** `/suppliers`, `/parts` and `/machines/[id]` put per-row edit
  forms in `<details>`, so every row shipped a complete form to the browser to hide it.
- **A dialog**, which `/jobcards` already did correctly and nothing else did.

`Modal` and `Sheet` had existed in the kit since the start and **nothing in the app used
them** except the nav's "More" menu and `/jobcards`. The 13 `<details>` blocks had grown
three different looks.

### What was added to the kit

- **`dialog-form.tsx`** - `DialogForm` (trigger + responsive dialog holding a
  server-rendered form), `DialogActions`, `DialogFields`, `DialogSection`. Children are
  server-rendered and passed as a prop, so actions, `Field`, `SubmitButton` and the
  offline hooks work unchanged. `DialogActions` watches `useFormStatus()` for the pending
  edge and closes the dialog, because every action here ends in a `redirect()`, which is a
  soft navigation that KEEPS client state: without it the dialog sat open over the row it
  had just written.
- **`action-menu.tsx`** - `ActionMenu`, a row's actions behind one button. A responsive
  sheet, not an anchored dropdown: no geometry to get wrong on a phone, and it can be
  TITLED with the row, which an anchored panel cannot. It deliberately does not close on
  click, because a nested `DialogForm` trigger lives inside it.
- **`menu-item.ts`** - `menuItemClass()`, the row look, in a module of its own.
- **`disclosure.tsx`** - one `<details>` treatment for reading, replacing three.
- **`facts.tsx`** - `Fact`/`FactList`, label-and-value rows, so a screen can STATE a value
  instead of rendering it inside a text box.
- `triggerLook="menuItem"` on `DialogForm` and `ConfirmDialog`, `look="menuItem"` on
  `SubmitButton`, because `cn` does not de-duplicate Tailwind: a `className` override
  leaves both the button's padding and the row's in the class list.

### Screens converted

Seventeen: `/tyres`, `/incidents`, `/settings`, `/faults`, `/fuel`, `/fines`, `/parts`,
`/team`, `/team/licences`, `/partners`, `/suppliers`, `/machines/[id]`,
`/contractor/settings`, `/contractor/clients/[id]`, `/documents/[id]`,
`/recurring/[id]`, `/admin/farms/[id]`.

Measured in a browser, visible form controls on the page at rest: `/tyres` 25 to 0,
`/settings` 22 to 0, `/incidents` 39 to 0, `/fuel` 20 to 0, `/team` 14 to 0, `/parts` 15
to 2 (the catalogue search stays), `/machines/[id]` to 4 (the daily meter-reading form
stays). `/machines/[id]` lost all 14 of its `<details>` blocks and its hand-rolled
absolute-positioned dropdown; every one of its bare placeholder-only inputs, which had no
label at all, became a `Field`. The `inputCls` ad-hoc input styling is gone from all three
files that carried it.

Two things were deliberately NOT converted, and the gate records why: the `/fines` capture
is a two-step GET flow (pick vehicle and date, the server looks up who was driving, then
the form renders with the driver suggested) and a dialog would break it, because
submitting a GET navigates; and `/machines/[id]` keeps its meter-reading form on the
Overview tab because logging hours is the daily task.

### The defect this forced out of /settings, before it could bite

`updateSettings` rebuilt the WHOLE settings blob from the submitted form, falling back to
a hardcoded default for anything absent. Correct while one form posted all 18 keys
together; **data loss** the moment the screen edits one group at a time. Saving quiet
hours would have reset the farm's VAT rate to 15%, its service thresholds to 25 hours and
its language to Afrikaans, with no error, and the screen would then have truthfully
reported the defaults it had just written.

So a partial form now declares what it owns (`__fields`) and `mergeSettings` merges over
what is stored; a form that declares nothing still owns everything, so the old whole-form
path is unchanged. Pure and tested: `src/lib/settings.test.ts`, 14 assertions, including
the asymmetry that an owned CHECKBOX absent means false (the only signal a browser sends
for "unticked") while an owned SELECT absent means keep. `formOwnsBilling` gates the
billing RPC, which overwrites all five identity columns from whatever it is handed and
would otherwise have blanked the farm's VAT number from the quiet-hours dialog.

Two smaller facts recorded while writing that test: the old `intOr` returned **0**, not
its default, for a missing key (`Number("")` is 0 and finite), and the old language read
reset to "af" when absent. Neither was reachable from the one form that posted every key.

### Two real bugs found by rendering it

- **`Overlay` leaked its scroll lock.** Each overlay snapshotted
  `document.body.style.overflow` on open and wrote it back on close, which is a race with
  two overlays: the inner one saves "hidden" and hands it back, and the last restore to
  run wins. Open a row menu on `/tyres`, open a dialog inside it, submit: the redirect
  remounts the page, the menu's cleanup restored "" and the dialog's then restored
  "hidden", so **the page could not be scrolled again until a reload**. The clean path
  unwound in the opposite order and looked fine. Now a module-level count: first to open
  locks, last to close restores.
- **A plain function re-exported from a "use client" module is a client reference.**
  `action-menu.tsx` briefly carried `export { menuItemClass }` as a convenience; calling
  it from a Server Component threw "Attempted to call menuItemClass() from the server" and
  took the whole of `/machines/[id]` to its error boundary. `tsc` and `next build` both
  pass. Worse, `/incidents` had the same bad import and **passed every gate**, because its
  one call sits behind `r.job_card_id` and the test farm's incident has no job card: it
  would have crashed for the first customer who linked a repair to an accident. The
  re-export is deleted, so the mistake is not available.

### The gate: pnpm ui:check

`scripts/ui_check.mjs`. Drives real Chrome over CDP with no new dependency (node 24 has a
global `WebSocket`), signs in as the click-through owner the same way `click_through.mjs`
does, and per route asserts: it renders, it did not fall into its error boundary, no raw
i18n key is on screen, nothing is open before anything is pressed, the number of visible
form controls is under a stated ceiling, and the first dialog trigger opens a labelled
`aria-modal` dialog that takes focus, locks scroll, and on Escape closes, unlocks and
returns focus to its trigger. Skips cleanly when there is no Chrome.

This closes the gap CLAUDE.md already named: a dialog is client state, so a harness that
reads HTML sees the trigger and never what it does. Both bugs above were invisible to
typecheck, lint, build, `db:check`, the 404 TS tests and `click_through`.

Three of its own defects, fixed, each worth knowing:

- It picked the app shell's **hidden mobile nav button** as "the page's first dialog
  trigger" (it carries `aria-haspopup="dialog"`), and `.focus()` on a `display:none`
  element does nothing, so it reported "focus was not restored" on four healthy pages. It
  now scopes to `main` and to visible elements.
- The error boundary has an `h1` of its own, so a crashed page read as healthy. It now
  carries `data-error-boundary`, which is cheaper and more honest than matching an English
  sentence that will be translated.
- `clickthrough@fleetwise.test` matched the raw-i18n-key regex, so "fleetwise.test" was
  reported as an untranslated key on two pages.

### The service worker stops pages hydrating after ~8 hard loads. Unresolved, pre-existing.

Found while chasing the last gate failure, and it is NOT caused by this session's work, so
it is recorded rather than fixed. Hard-navigating a single tab about eight times with
`sw.js` in control leaves the next page rendered correctly and **never hydrated**: buttons
visible, enabled, React attached to nothing, clicks do nothing, no console error and no
error boundary.

How it was pinned down: `/machines/[id]` failed as the 9th route and passed alone; 8 loads
of `/team` then `/machines/[id]` reproduced it, so it was cumulative, not route-specific;
`/machines/import`, `/statements` and `/settings/api`, **none of them touched this
session**, and `/tyres` at a third of the bundle size, all failed identically, so it is
neither a regression nor bundle weight; and with `Network.setBypassServiceWorker` the 9th
and 10th loads hydrate fine. The gate therefore bypasses the service worker, because it is
measuring the interface.

Whether a real person on a real device can provoke it is **not answered**. Eight rapid
hard loads in one tab is not an obvious user pattern, and normal use is client-side
routing, but this is a PWA that is meant to be relaunched from a home screen, and the
symptom a customer would report is "the buttons don't work". Worth a browser and a phone.

### A second partial-form hazard, and a second real bug, on the partner side

`/contractor/settings` is the same shape `/settings` was: about twenty-five controls in
one `<form>`, five cards, a jump nav and a sticky Save. Splitting it into per-group
dialogs hit the same hazard for the second time, so the ownership half of it moved into
`src/lib/partial-form.ts` (`ownedKeys`, `owns`, `ownsAny`, `ownedUpdate`) with its own
eight tests, and `src/lib/settings.ts` now imports from there instead of keeping a copy.

Worse here than on the farm side, because `updatePartnerProfile` is one `.update()` over
every column and the ones it would have reset are the ones that appear on a contractor's
tax invoices: `vat_registered`, `default_vat_rate_bps`, the quote/invoice/credit-note
number prefixes, and the letterhead colours. Resetting an invoice prefix silently
restarts a number series a partner's books depend on. `ownedUpdate` omits a column the
form does not own, rather than sending a default, so the database keeps what it has.

**And the VAT rate on that screen never saved.** `updatePartnerProfile` read
`vat_percent`; nothing on the page has ever posted that. `VatRateField` renders a percent
box with NO `name` and posts a hidden `vat_rate_bps` in basis points, so
`formData.get("vat_percent")` was always null, the `?? "15"` took over, and
`default_vat_rate_bps` was written as 1500 on every single save no matter what the partner
typed. The control was decorative. It happens to equal the current SA rate, which is why
nobody noticed, and the stored value goes onto their invoices. It now reads
`vat_rate_bps` first and keeps `vat_percent` as the fallback, because that IS the
convention on the document, order and recurring-expense forms.

A typo in a group's `owns` list is silent in the same way, so the five group lists live in
`src/lib/partner-profile.ts` and `partner-profile.test.ts` asserts three things: every
editable column is reachable from exactly one group, no group names a column the action
cannot write, and the list matches the keys in the action's own `ownedUpdate` spec, read
out of the source. That last one is the anti-drift check: add a column to the action and
forget the list and it becomes uneditable on a screen that now edits group by group.

### Which forms were deliberately left on the page

Four, and the reasoning is the same each time: the form is the repeated act, not the
occasional one, and putting the daily task behind a button is the tail wagging the dog.

- `/parts` keeps its catalogue search. It is how you use a few hundred parts.
- `/fines` keeps step one of its capture (vehicle + offence date). It is a GET that the
  server uses to look up who was driving, and submitting a GET navigates, which would
  close the dialog it was submitted from.
- `/machines/[id]` keeps the meter-reading form on its Overview tab. Logging hours is
  what an operator opens that screen to do.
- `/documents/[id]` and `/recurring/[id]` keep their line-item forms. Building a document
  means adding five lines; five dialog round trips would be worse than the wall.

### What the browser gate can and cannot reach

`ui:check` covers eleven routes. The other six converted screens cannot be reached by it,
and the file says so rather than leaving them looking forgotten: `/suppliers`,
`/contractor/settings`, `/contractor/clients/[id]` and `/recurring/[id]` are
workshop-only, `/admin/farms/[id]` is rr_admin only, and `/documents/[id]` needs a
document row the click-through farm does not have (verified: zero `partner_documents`).
The only throwaway credential in the repo is a farm owner. There ARE workshop accounts on
the live database, but they are real people's, so they were left alone.

So those six are covered by typecheck, lint, build and the unit tests around the actions
they post to, and **not by a browser**. The partner VAT fix in particular is proven by
reasoning about what the form posts plus 8 + 5 unit tests, not by watching it save. A
throwaway workshop and an rr_admin in `seed_test_farm.mjs` would close that, and is the
obvious next step for this gate.

### Second pass: what the first one missed

A sweep for the same CLASS of defect rather than the same screens, plus gates so each one
cannot come back.

**Three more hand-rolled dropdowns, all `<details>` wearing a button's clothes.**
`/jobcards` styled its `<summary>` with `buttonVariants` and the partner's "New document"
hand-rolled `bg-brand-600 text-white` in raw classes, so both LOOKED like the primary
button on every other screen while opening a panel with no focus trap, no Escape and no
way out on a phone but finding the summary again. Being `<details>` they were also in
flow, so opening one pushed the list below it down the page. `/admin/templates` kept a
three-field edit form in one per row. All three are now `DialogForm`/`ActionMenu`.

**Six hand-rolled primary buttons, two of them below the touch floor.** `/checklists`
had `py-2`, about 36px tall, so the single call to action on that screen was a SMALLER
target than every other button in the product, on the device it is used on;
`jobcard-media` and `work-request-media` were `min-h-[44px]` against the kit's 48px.
`not-found` and `/offline` were copies for no reason. All now go through
`buttonVariants`. The landing page keeps its own pair, because its two CTAs are a matched
set and rewriting only the brand-filled one would leave them different heights.

**Loading states: 15 routes had none**, including `/tyres`, `/incidents`,
`/team/licences`, `/statements`, `/home` and `/account`, so navigating to them showed
nothing at all while the server worked. Every route under `(app)` now has one, shaped
from what the page actually renders.

**Two `<details>` were left alone, deliberately.** `/billing` is a no-JS GET two-step
whose panel is opened by a searchParam because client-side scroll cannot open a
`<details>`; `/d/[token]` is a public link opened from an email and has ZERO JavaScript
on it. A dialog would make both worse.

### Wide tables on a phone, and the two bugs that measuring found

`<Table stacked>`: below `lg` each row becomes a labelled card, from `lg` up it is an
ordinary table. Written as plain CSS in `globals.css` rather than nested Tailwind
arbitrary variants (`max-lg:[table[data-stacked]_&]:flex`), because whether the generator
emits a bracket inside a bracket is not something to find out from a phone. The `<thead>`
is `sr-only`, not `display: none`, so the real `<th scope="col">` stay in the
accessibility tree and the visible labels are aria-hidden duplicates for the eye.

Applied to 13 tables across 10 screens. **Every cell's label was then checked against its
own column** by parsing each table: 13/13 with matching column and cell counts, 0 labelled
with the wrong column, 0 gaps. Measured at a true 360px: stacked 328px wide with no
overflow, rows as 12px-radius cards bordered `rgb(230 226 215)` light and `rgb(83 82 74)`
dark, label left and value right; the same markup unstacked is 576px in a 360px frame.

Two real defects came out of measuring rather than reasoning:

- **`/reports/assets` forced a 442px layout on a 360px phone, and had done all along.**
  Not a regression: it survived removing `data-stacked` and hiding the table entirely.
  Three whole-fleet money tiles shared a hard `grid-cols-3`, and `rands` joins thousands
  with U+00A0, a NO-BREAK space, so "R1 500 000,00" is a single unbreakable ~200px token
  at `text-3xl`. Three cannot share 360px, so Chrome widened the layout viewport and
  ZOOMED THE WHOLE PAGE OUT instead of scrolling. Nothing overflowed, which is exactly
  why no scrollbar ever gave it away, and any farm with a combine hits it. The grid is
  now responsive; the two other fixed-column money grids step their value down on a phone
  as the dashboard's fuel tiles already did.
- **The stacked table itself regressed at 1024px.** Dropping the scroll wrapper looked
  right, because below `lg` cards cannot overflow; it is wrong the moment the columns come
  back. At a 13-inch laptop `/team` laid out an 823px table inside a 687px column and
  pushed the document to 1112px, so the page scrolled sideways. `lg:overflow-x-auto`
  restores the container exactly where it becomes a table again.

### Gates added, all mutation-tested

Three `design_lint` rules: `no-details-as-button`, `kit-button` and
`stacked-table-labels` (no more unlabelled cells than there are empty `<Th />`; the ten
converted pages sit exactly at that bound). `kit-button` took three attempts and each
failure is recorded in the rule, because they are the two ways a checker dies: it first
missed every real case (`<button` alone on a line never matched `[\s>]`), then it cried
wolf at a brand-filled `<span>` badge and at the bottom bar's nav tile. It now walks back
to the element that owns the class and requires horizontal padding.

`ui:check` gained two dimensions beyond dialogs: **28 routes at 360px** and **28 at
1024px**. The 360px pass asserts two different failures, and the second is the one that
hid: `scrollWidth > innerWidth` is ordinary sideways scroll, while `innerWidth > 360` is
the silent one where the browser zooms the page out instead.

A sixth `partner-profile` test walks the contractor settings form's own `name=`
attributes and insists each is a column the action reads. That is the guard for the VAT
bug found earlier, where the action read `vat_percent` and the form has only ever posted
`vat_rate_bps`: strings on both sides, so nothing else could see it.

### Cleaned up

Two imports this session orphaned (`ChevronDownIcon` on `/machines/[id]`, `menuItemClass`
in `action-menu.tsx`) are gone. Twenty-one others were checked against HEAD, found to
predate this work, and left alone rather than churning unrelated files.

### Gates

typecheck, lint, test (418, from 404: +8 partial-form, +6 partner-profile),
i18n:parity (4871/4871), i18n:keys, errors:check, design:lint (34/34 contrast, 0
violations), dashes:check, db:check (exit 0), build, click_through (22 screens, 9 RLS
writes), ui:check (11 dialog routes, 28 routes at 360px, 28 at 1024px, exit 0). All green.

Proven by running it, not asserted from the code: on `/tyres`, open a row menu, open the
tread-check dialog inside it, type a reading, submit, and the dialog closes itself with
"Check saved." on `?saved=checked`; on `/settings`, edit quiet hours and read all 25
stated values back, **exactly one changed** (20 to 21) and the other 24 survived, which is
the data-loss case the merge exists for. Every gate added this session was mutation-tested
against the defect it exists for, with a passing control either side.

**Left undone.** Twenty-one screens carry the pattern, and a final sweep for screens with
four or more inline fields leaves exactly two, both on purpose:

- **`/work/[id]`**, the workshop's live working screen: status chips, a status-with-note
  form, a progress note and a quote amount, every one of them one or two fields used
  repeatedly while a job is open. Same reasoning as the line-entry forms on
  `/documents/[id]`, the meter reading on `/machines/[id]` and step one of `/fines`:
  the REPEATED act stays on the page, and a dialog would add a tap to the most frequent
  action on the screen.
- **`/m/[token]`**, the no-login QR page a worker uses standing at the machine. It is a
  standalone kiosk flow with no app chrome and no JavaScript, and dialogs would need JS.

`/contractor/clients` and `/recurring-expenses/[id]` were the last two genuine holdouts
and are now converted; the second was the odd one out against `/recurring/[id]`, its own
sibling, which had been done in the first pass.

Six of the seventeen converted screens are not covered by `ui:check` for want of a
workshop and an rr_admin credential, as above; `/contractor/settings` in particular is
proven by unit tests and a static field-name guard, **not by watching it save**. Adding a
throwaway workshop and an rr_admin to `seed_test_farm.mjs` is the obvious next step and
would close both that and the `/documents/[id]`, `/suppliers` and `/admin` gaps at once.

The service-worker hydration finding is unresolved and needs a phone. Nothing here has
been pushed or deployed, and everything on the previous entries' open lists is still open.

## 2026-09-23 (later) - The sidebar: where it was left, what it is called, and what it costs

A report, not a hunch: "when I click on something it auto scrolls back up in the side bar
instead of staying at the current position". The first three attempts to reproduce it
failed and said the position was KEPT, which is not the same as the bug not existing.

### Reproducing it

A programmatic `.click()` on a sidebar link kept the offset (`909 -> 909`). A real mouse
press did not navigate at all, because the first-run tour was open over the sidebar
(`probe-cover.mjs` found the blocker: `fixed inset-0 z-50` from `src/components/tour.tsx`).
With the tour marked seen, a real press also kept the offset, and `sameDoc=true` said the
navigation was client-side.

That is the answer to the wrong question. A client-side navigation keeps the offset **for
free**, because React never unmounts the panel. The two paths that do unmount it were
never tested, and both were broken:

```
desktop sidebar, HARD navigation : 909 -> 0   RESET
mobile "More" sheet, reopened    : 943 -> 0   RESET
```

The sheet is the unconditional one: it mounts fresh on every open, so a person who
scrolled past nine books screens to reach Settings was put back at the top **every single
time**. The sidebar resets on any full document load, which for a PWA relaunched from a
home screen with a service worker serving the document is not a rare event.

### The fix, and the bug inside the fix

`src/components/ui/use-scroll-memory.ts` stores the offset per tab session and restores it
in a layout effect, before paint. `ScrollArea` takes `rememberKey` and `revealActive`;
`Overlay`/`Sheet` take `rememberKey` for the panel, which IS the scroller for a bottom
sheet.

The first version stored the offset and still reopened at the top, with the code visibly
in place. Instrumenting `sessionStorage` rather than re-reading the code:

```
after scrolling  : {"farmgear:scroll:nav-more":"500"}
storage on close : {"farmgear:scroll:nav-more":"0"}
```

A **detached element reports `scrollTop` 0**, and React tears the portal down before the
effect's destroy runs, so the obvious cleanup (`write(key, el.scrollTop)`) faithfully
stored 0 every time. The listener now keeps the value in a local, read synchronously while
the node is still in the document.

Two more measured corrections: focusing the panel after the restore undid it, so the focus
call passes `preventScroll` where a remembered offset exists; and a sticky child is
constrained by the scroll container's **padding box**, so `py-2` on the scroller pinned
every heading 8px down and left a strip above it that rows scrolled through in the open.
The padding moved onto the `<nav>`. Measured: heading top 8, then 0.

### What else the sidebar was getting wrong

- **Sticky section headings.** 900px of nav with no heading in sight. `z-10` puts them
  above the `ScrollArea`'s top fade; verified with `elementFromPoint` at the heading's own
  coordinates, which returns `P.sticky` and not the fade.
- **`revealActive`.** Arriving on `/settings` from an email link showed the top of a list
  whose active row was 600px below the fold. On a fresh session it now reveals it:
  `{"scrollTop":945,"label":"Settings","inView":true}`.
- **The footer was four stacked blocks**: a Language row, an Appearance row, the person's
  name, a Sign out button, all permanently on screen. They are now behind the row that
  names you, an `ActionMenu` titled with the person. Sidebar controls at rest **4 to 1**,
  nav height **460px to 587px** on a 720px laptop. Verified by pressing them, not by
  reading the markup: theme `unset -> light`, and sign out `/dashboard -> /login`.
- **"Everything else" had grown to twelve destinations**, which is a bucket, not a
  heading, and the sticky headings make a heading that says nothing more conspicuous
  rather than less. Two of the twelve are a different KIND of thing, so they are named:
  **Account** (settings, billing, API access, admin, subscriptions) and **Help**. The
  remaining seven keep the existing label, because inventing a taxonomy for them is a
  product decision and not a UI one. Nothing is hidden; every destination is still a
  visible row.

`tailItems` became `tailGroups`, defined once and spread by all four consumers (sidebar,
"More" sheet, command palette, service-worker warm list) instead of three call sites
rebuilding the same object literal. Deduped by href, which caught a live latent duplicate:
an account that is both owner and rr_admin matched `isOwner ? [billing]` and
`isAdmin ? [..., billing]` and got `/billing` twice in one group.

Measured after: sidebar 6 groups, 25 destinations, **0 duplicates**; the "More" sheet
mirrors it group for group.

### Gates

typecheck, lint, test (418), i18n:parity (4873/4873, +2 keys in both languages),
i18n:keys, errors:check, design:lint (34/34 contrast, 0 violations), dashes:check,
db:check (exit 0), build, click_through (22 screens, 9 RLS writes), ui:check (11 dialog
routes, 28 at 360px, 28 at 1024px, exit 0). All green.

**Left undone.** Whether a real person provokes the reset on a phone is still unmeasured;
the fix removes the cause on every path that was reproducible here, but the service-worker
hydration finding above it is still unresolved and still needs a phone. Nothing has been
pushed or deployed. Everything on the previous entries' open lists is still open.

### Afterwards: the mobile gate was a selection, not an inventory

Asked whether the mobile UI was right, the honest answer was that nobody knew. `ui_check`
measured **28 routes at 360px against 82 `page.tsx` files**, hand-picked. The other 54 were
not covered elsewhere, they were unmeasured, and "the gate is green" had been standing in
for "the product fits a phone".

Sweeping every route the click-through owner can actually open, 53 of them, found one:

```
FAIL  /machines/f0000000-...-aa01   zoomed out: layout 415px
52/53 clean at 360px, 1 with a problem
```

`/machines/[id]` is the densest and one of the most-used screens in the product, and it had
been rendering **zoomed out on every phone**. The cause is the same failure mode already in
the rules and it still hid: five tabs (`Overview`, `Servicing`, `What it costs`, `History`,
`Papers & licence`) come to 415px at their natural width, and when content cannot fit Chrome
does not add a scrollbar, it widens the layout viewport. No overflow, no scrollbar, nothing
to notice, just smaller text everywhere.

Finding it needed the document forced to 360px before walking for elements wider than their
container; at the real (widened) viewport nothing is over-wide, because everything fits
inside 415. The first walk returned `deepest: [], count: 0` and said the page was fine.

`Tabs` now scrolls sideways (`overflow-x-auto` plus `shrink-0` on the buttons, without which
flex squeezes the labels instead of scrolling). Measured after: `innerWidth 360`,
`pageScrollWidth 360`, tablist `328` visible of `506`. Verified by eye as well as by number:
the active underline still meets the strip border, and the cut-off tab at the right edge is
the affordance, which is why the scrollbar is hidden here and nowhere else.

`MOBILE_ROUTES` is now the inventory rather than a selection from it, 53 routes at both
360px and 1024px. What stays out is only what this credential cannot open: workshop-only
(`/contractor/*`), rr_admin-only (`/admin/*`), operator-only (`/driver`), the signed-out and
marketing pages, and the token routes, which need a token to mean anything. Those remain
genuinely unmeasured on a phone and are the next gap to close.
