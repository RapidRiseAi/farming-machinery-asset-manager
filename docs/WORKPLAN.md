# WORKPLAN — UI/UX rework + v1 backend completion

Mission: turn FarmGear into a modern, aesthetic, mobile+desktop PWA and close every
remaining v1 scope gap. Source of truth: `docs/SCOPE.md`; conventions: `CLAUDE.md`.
All work lands on `claude/farmgear-ui-ux-backend-th78c7`.

## Decisions taken (defaults, noted per instructions)
- **Branch:** the harness designates `claude/farmgear-ui-ux-backend-th78c7`; all work
  lands there (the mission text's `claude/week-1-foundation-o9e7i8` is superseded).
- **Charts:** hand-rolled server-rendered SVG components — no chart library (bundle lean).
- **PDF:** `pdf-lib` (pure JS, used only in server route handlers → zero client-bundle
  impact) + print-friendly views. No Playwright/Chromium on the deploy target.
- **Fonts:** system font stack (no webfont download on rural bandwidth).
- **Voice notes:** MediaRecorder → webm/opus → private Storage bucket via the existing
  service-role pattern; recorded on both the public QR page and the in-app fault form.
  Rows in `attachments` (kind `voice`), since `faults` has no voice column.
- **Job-card autosave:** localStorage draft + debounced server save (survives dropped
  connection, Scope §7).
- **Impersonation (C4):** RR admin "acts into a farm" via an explicit farm-context
  action that writes an `audit_log` entry (RPC), on top of existing audit triggers.

## Migration number assignments (serialized — no other task may create migrations)
- `0205` — C2/C3 (service-due notification engine + digest/stale-nudge + quiet hours)
- `0206` — C4 (admin: impersonation audit RPC, template-library policies if needed)
- `0207` — B4 (fault-voice storage bucket + storage policies)

Every migration ships with RLS coverage in `supabase/tests/rls_isolation.sql`
(shared file — those three tasks run **serially** for test edits, in number order,
or append clearly separated sections; integrator resolves).

## Shared-file protocol
- `src/lib/i18n/en.json`: each task adds keys **only under its own namespace(s)**;
  never reformat the file. Integrator resolves append conflicts.
- `src/lib/i18n/af.json`: untouched until B9 (final Afrikaans pass).
- `src/app/(app)/layout.tsx`, `src/components/ui/*`, tokens: owned by A; B tasks
  consume but do not modify (kit change requests go to the integrator).
- `src/lib/money.ts`: owned by B3 (adds VAT split helpers).
- `CLAUDE.md`, `docs/WORKPLAN.md`, `vercel.json`→C3: single owners as noted.

## Task DAG

### A — Design foundation  [GATES all B tasks]
Goal: real design system + responsive app shells + component kit.
Owns: `tailwind.config.ts`, `src/app/globals.css`, `src/app/(app)/layout.tsx`,
`src/components/ui/**` (new), light restyle of `src/app/(app)/dashboard/page.tsx`
(to prove the kit; B1 rebuilds it after), `en.json` `nav`/`ui` namespaces.
Accept: tokens (brand+neutral scale around status.ok/due/overdue, type scale, radii,
shadows, focus rings); mobile bottom tab bar + contextual header; desktop persistent
sidebar + top bar (genuinely different layout, not stretched mobile); kit: Button,
Input/Select/Textarea, Field, Card, Table, Badge/StatusPill, Modal/Sheet, Toast,
Tabs, EmptyState, Skeleton, Stat; a11y (labels, focus-visible, AA contrast, ≥44px);
Reports added to nav; renders at ~360px and ≥1024px; gates green; no bundle bloat.

### B — Surfaces (parallel after A; worktrees; one owner per route dir)
- **B1 Dashboard** — owns `dashboard/**`. Full Scope §4.6 overview: KPI cards
  (overdue/due-soon/OK, open faults, in-workshop, spend this vs last month + delta),
  6-month spend trend + spend-by-type + cost-per-machine (SVG), actionable faults
  list, drill-downs; excludes retired/sold everywhere (C8); mobile stacked/
  prioritized, desktop dense multi-column. Namespace `dashboard`.
- **B2 Machines list/new/import (+C7)** — owns `machines/page.tsx`, `machines/new/**`,
  `machines/import/**` (new), `machines/actions.ts`, `src/lib/machine-options.ts`,
  `src/components/machine-fields.tsx`. Cards on mobile/table on desktop, filters/
  search, bulk CSV import (upload → validated per-row preview → insert, farm-scoped).
  Namespace `machines`.
- **B2b Machine detail (+C1)** — owns `machines/[id]/**`, `src/components/
  machine-photos.tsx`. Proper profile: identity card, meter graph (SVG), **service
  plan with due bars + line CRUD + apply-template** (C1), full chronological history
  timeline (job cards, faults, readings, photos, watch items), lifetime stats,
  QR page polish; links to `/machines/[id]/file.pdf` (C9). Namespace `machine`.
- **B3 Job cards (+C5)** — owns `jobcards/**`, `src/lib/money.ts`. Fast mobile data
  entry; draft autosave; locked-after-approval affordance; line-item UX with running
  totals; **VAT-inclusive entry** converting to ex-VAT integer cents via farm
  `vat_rate` with the split shown (integer math only); link to `/jobcards/[id]/pdf`
  (C9). Namespace `jobcards`.
- **B4 Faults + public QR** — owns `faults/**`, `src/app/(public)/m/[token]/**`,
  new `src/app/api/public/**` service-role routes, new capture components
  (`src/components/fault-*.tsx`), migration `0207` (voice bucket + policies) + RLS
  test section. 30-second flow, common-fault buttons, photo attach + voice note on
  public and in-app forms; public path stays anon-DB-free. Namespace `faults`, `qr`.
- **B5 Reports (+C6)** — owns `reports/**`. Rich, period-filterable, printable views
  for the four report families; CSV export per family (route handlers); print CSS;
  PDF links wired to C9 routes. Excludes retired/sold from defaults (C8).
  Namespace `reports`.
- **B6 Team/Settings/Notifications** — owns `team/**`, `settings/**`,
  `notifications/**`. Kit rework; legible settings (thresholds, approval, cost
  visibility, quiet hours, VAT rate, language); notification centre with
  read/unread + templated rendering. Namespaces `team`, `settings`, `notifications`.
- **B7 Admin (+C4 UI)** — owns `admin/**`. Console rework; per-farm usage/adoption
  stats (machines, active users, job cards/month, last activity); farm-context
  impersonation entry (calls C4 RPC); service-template library management.
  Depends on C4 backend (0206). Namespace `admin`.
- **B8 Auth & onboarding** — owns `(auth)/**`, `src/app/page.tsx`, new
  `onboarding/**` route. Polished sign-in; first-run checklist driving: add machines
  → apply service template → print QR → invite team (Scope §11, product side).
  Namespace `auth`, `onboarding`.
- **B9 Afrikaans pass** — owns `af.json`. LAST task: fill real Afrikaans for every
  `en.json` key; verify rendering with `language: "af"`.

### C — Backend completion
- **C2+C3 Service-due notifications + nightly recompute** — one task. Owns migration
  `0205`, RLS test section, `src/app/api/cron/**` (new), `vercel.json` (new), cron
  docs in README section of migration header. Enqueue due-soon/overdue transitions,
  weekly digest, stale-meter nudge; honor per-farm thresholds + quiet hours
  (delayed release, not drop); exclude retired/sold (C8); nightly route calls
  `app.recalc_all_due()` + enqueues (service-role, `CRON_SECRET`-guarded).
- **C4 Admin backend** — owns migration `0206` + RLS test section: impersonation
  audit RPC (`app.log_admin_farm_access`), any missing `service_templates` policies
  for RR-global template CRUD. (UI in B7 — same agent, backend first.)
- **C8 Retired/sold exclusion** — cross-cutting acceptance criterion on B1, B2b,
  B5, C2; verified at integration (no standalone task).
- **C9 PDFs** — owns `src/lib/pdf/**` (new), `src/app/(app)/jobcards/[id]/pdf/route.ts`,
  `src/app/(app)/machines/[id]/file.pdf/route.ts` (new route dirs — no conflicts),
  `package.json` (adds `pdf-lib`). Job-card PDF + machine-file ("service book") PDF;
  auth+RLS guards reused; server-only dependency.

## Order of execution
1. Wave 0 (now): **A** + **C2/C3** in parallel (disjoint files).
2. Wave 1 (A merged): **B1, B2, B2b, B3** in parallel worktrees.
3. Wave 2: **B4, B5, B6, B8, C4+B7** in parallel worktrees.
4. Wave 3: **C9**, then **B9** (needs final en.json), docs update, final gates,
   runtime smoke test, push + draft PR refresh.

Every task: leave the repo green (`pnpm typecheck && pnpm build && pnpm lint`,
plus `pnpm db:test` if DB touched); commit with a clear message.

## Status
- [x] Baseline green (typecheck, lint, build, db:test) — 2026-07-18
- [x] Plan written
- [ ] A merged
- [ ] B1–B9 merged
- [ ] C2/C3, C4, C9 merged
- [ ] Final verification + push + PR
