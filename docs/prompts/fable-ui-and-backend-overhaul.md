> **How to launch this**
> Start a fresh Claude Code session **on model Fable 5** (`claude-fable-5` — e.g. `/model claude-fable-5`
> or the model picker), open it in the `farming-machinery-asset-manager` repo on branch
> `claude/week-1-foundation-o9e7i8`, and paste **everything below the line** as your first message.
> Fable is the lead — it plans, spawns **Opus 4.8** (`claude-opus-4-8`) subagents to do the building,
> reviews their work, and integrates it. Let it run; answer only the blocking questions it raises.

---

# FarmGear — Full UI/UX Rework + Backend Completion (Fable orchestrates, Opus builds)

## Your role & the model split

You are **Fable 5** (`claude-fable-5`), the **lead architect, orchestrator, and reviewer** for this mission.
You do **not** write the bulk of the feature code yourself. You **plan**, **decompose**, **spawn Opus 4.8
subagents** to build, then **review, correct, and integrate** their work until the whole thing is correct and
coherent.

- Spawn every builder subagent with the **Agent** tool: `subagent_type: "general-purpose"`, **`model: "opus"`**
  (this is `claude-opus-4-8`). Use `isolation: "worktree"` for any stream that runs in parallel with another,
  so subagents never fight over the same working tree.
- Continue a subagent (send corrections, more context, the next slice) with **SendMessage** to its id/name —
  that keeps its context intact. A fresh `Agent` call starts cold, so prefer SendMessage for iteration.
- A subagent's final report is **not** shown to the user and is **not** proof of correctness. **You** verify by
  reading the actual diff and running the gates. Never rubber-stamp. Never relay a subagent's "done" as done
  until you've checked it.

## The mission (the overarching goal — hold this the whole way)

Turn FarmGear from a *functionally-complete-but-plain* app into a **modern, aesthetic, genuinely
user-friendly product** with **distinct mobile and desktop experiences** and a **rich dashboard**, **and**
close every remaining **backend gap** and **missing front-end surface/stat** in the v1 scope. When you're
done: the UI looks and feels like a polished 2026 SaaS PWA on a mid-range Android *and* on a desktop browser,
every v1 scope item works end-to-end, the repo is green (typecheck + build + lint + `pnpm db:test`), and it's
pushed to `claude/week-1-foundation-o9e7i8` with the draft PR refreshed.

## Step 1 — Ground yourself before planning (do this first, yourself)

Read, in this order, and take notes:
1. `docs/SCOPE.md` **in full** — it is the source of truth. Pay special attention to §4 (functional detail),
   §4.6 (Dashboard & Machine History), §4.8 (Reports), §4.9 (Admin/Tenancy/Settings), §6 (data model),
   §7 (non-functional), and **§13 (Out of scope — a hard NO)**.
2. `CLAUDE.md` — conventions, decisions, and the "current status" block (what's already built).
3. The codebase: the route tree under `src/app`, `src/lib`, `src/components`, `tailwind.config.ts`,
   `src/app/globals.css`, and the migrations in `supabase/migrations/` (0001–0204) plus
   `supabase/tests/rls_isolation.sql`.

Then run the current gates yourself so you know your starting line is green: `pnpm typecheck`, `pnpm build`,
`pnpm lint`, `pnpm db:test`. Fix nothing yet — just establish the baseline.

## Non-negotiable constraints (enforce these on every subagent, and in your review)

These come straight from `CLAUDE.md` and `docs/SCOPE.md`. A subagent's work is **rejected** if it violates any:

- **Tenancy & RLS are the sole guarantor of isolation.** Every business table carries `farm_id`. Do **not**
  weaken, bypass, or route around RLS. Any new table/column/policy ships with matching coverage in
  `supabase/tests/rls_isolation.sql`, and **`pnpm db:test` must stay green**. New DB work goes in **new,
  sequentially-numbered** migration files — never edit an applied migration.
- **Money is integer cents, ex-VAT**; `vat_rate` is captured separately. **No floats anywhere near money.**
- **History is structural**: soft-delete (`deleted_at`/`deleted_by`), append-only `audit_log`, job cards lock
  after approval. Don't break these triggers.
- **Public QR flow has ZERO anon DB access.** Submissions go through **service-role server routes/actions**
  that validate the per-machine `public_token`. Never expose an anon Supabase query on the `/m/[token]` path.
- **i18n from day one.** All new UI strings go through the `t()` helper with keys in
  `src/lib/i18n/en.json`. The Afrikaans pass (`af.json`) is part of this mission — see Workstream B.
- **§13 is a hard NO.** Do **not** build: GPS/telemetry, anomaly ML, parts inventory, invoicing/accounting,
  crop/livestock/labour, store apps, full offline sync, or a 3rd language. Also **do not** build the deferred
  items: **WhatsApp Stage 2** (WhatsApp send/receive), the **v1.5 diesel/fuel features** (the fuel *tables*
  exist from Week 1 but build no fuel UI/logic now), and daily-backup/PITR ops. In-app notifications are in
  scope; WhatsApp delivery is not.
- **Keep the PWA lean.** Mid-range Android is the target. Justify every new dependency; prefer small/native
  approaches (CSS, SVG, server components) over heavy libraries. If you add charts or PDF, pick the lightest
  credible option and keep it out of the first-load bundle where possible.
- **Never leave the repo broken.** Every integrated increment must pass typecheck + build + lint + `db:test`.

## Step 2 — Produce the plan (yourself, before spawning anyone)

Write `docs/WORKPLAN.md`: a task DAG covering Workstreams A, B, and C below, with for each task — its goal, the
**exact files/paths it owns**, its dependencies, and its **acceptance criteria**. Partition tasks by
file-ownership so parallel subagents never touch the same files. Mark the **dependency gates** (see
Orchestration). If — and only if — you hit a decision that genuinely changes the build and isn't already
answered by SCOPE/CLAUDE (e.g. a real product trade-off), ask the user with **AskUserQuestion**; otherwise pick
the sensible default, note it in `WORKPLAN.md`, and proceed. Do not stall on things you can decide.

---

## Workstream A — Design foundation (this GATES the front-end rework)

One Opus subagent, reviewed and merged by you, **before** any page-level rework starts. Deliver a real design
system, not ad-hoc styling:

- **Design tokens** in `tailwind.config.ts` + `globals.css`: a considered color palette (keep the traffic-light
  service semantics — `status.ok/due/overdue` — but build a proper neutral/brand scale around them), type
  scale, spacing, radii, shadows, focus rings. Light theme is the baseline (scope sets `color-scheme: light`);
  only add dark mode if it's cheap and clean.
- **Responsive app shells** replacing the current flat top-nav in `src/app/(app)/layout.tsx`
  (today it's a single row of links in a `max-w-3xl` container):
  - **Mobile**: a bottom tab bar (thumb-reachable), a header with contextual title/actions, and bottom-sheet
    patterns for forms/quick actions. Tap targets ≥44px.
  - **Desktop**: a persistent left sidebar with sections + the role-gated links, a top bar with search/user,
    and **multi-column, data-dense** content. Not just the mobile layout stretched wide — a genuinely
    different information layout.
- **A shared component kit** (in `src/components/ui/`): Button, Input/Select/Textarea (labelled, error states),
  Card, Table (sortable/scrollable, dense on desktop), Badge/StatusPill (traffic-light), Modal/Sheet,
  Toast, Tabs, EmptyState, Skeleton, Stat/KPI card. Accessible: labels, focus-visible, aria, WCAG-AA contrast.
- **Feedback patterns** for Server Actions: success/error toasts, pending states, and skeletons for async
  server components.

**Acceptance:** shells render correctly at mobile (~360px) and desktop (≥1024px) widths; the kit is used by at
least the dashboard so it's proven; typecheck+build+lint green; no bundle bloat. **Nothing in Workstream B
starts until you've reviewed and merged this.**

## Workstream B — Front-end rework, full dashboard, and the missing surfaces

Rework **every** existing surface onto the design system with real mobile+desktop treatments, and add what's
missing. Partition into per-surface Opus subagents (they can run in parallel *after* Workstream A lands, in
worktrees, because they own different route files). Each surface must have proper empty/loading/error states,
i18n via `t()`, and both layouts.

- **Full dashboard** (`src/app/(app)/dashboard/page.tsx`) — the current version is a few plain count tiles.
  Rebuild it into a real overview per Scope §4.6: KPI cards (overdue/due-soon/OK service, open faults,
  in-workshop, spend this vs last month with a delta), a **spend trend** (last ~6 months) and **spend-by-type**
  and **cost-per-machine** visualizations (lightweight charts/SVG), an actionable open-faults list, and
  drill-down links. Desktop = dense multi-column; mobile = stacked, swipeable/prioritized. **Exclude
  `retired`/`sold` machines from all counts and alerts** (this is also backend gap C8 — coordinate).
- **Machines** (`machines` list/filter/search, `new`, `[id]`, `qr`) — polished list (cards on mobile, table on
  desktop), better filters/search, and a proper **machine detail** page with a **history timeline** (services,
  job cards, faults, readings, photos in one chronological view — Scope §4.6).
- **Job cards** (`jobcards`, `[id]`) — the mechanic's core flow. Make data entry fast on mobile; add
  **draft autosave** so a half-filled card survives; clear locked-after-approval affordance; line-item UX for
  parts/labour/other with running totals.
- **Faults** (`faults`) — the worker's 30-second flow. Fast report form; on the public `/m/[token]` page and
  the in-app form, support **photo attach and a voice-note capture** (record → upload to Storage via the
  existing service-role/photo pattern; Scope §4.5). Keep the public path anon-DB-free.
- **Reports** (`reports`) — richer, printable, exportable views for the four report families (cost per machine,
  spend by type, service compliance, recurring problems). Wire the export buttons to Workstream C6.
- **Team, Settings, Notifications, Admin** (`team`, `settings`, `notifications`, `admin/farms`) — rework onto
  the kit; make Settings and the RR-admin console pleasant and legible; surface the new admin stats (C4).
- **Auth & onboarding** (`(auth)/login`, first-run) — polished sign-in, and an **onboarding** flow that helps a
  new farm add its first machines and print QR codes (Scope §11 playbook, product-side only).
- **Afrikaans i18n pass** — fill real Afrikaans **values** in `src/lib/i18n/af.json` for every key present in
  `en.json` (and every new key you add). Verify the app renders correctly with `language: "af"`.

## Workstream C — Backend completion (the remaining v1 gaps)

Discrete Opus subagents. **Migrations must be serialized** — assign a single ordering owner so new files stay
sequential (…0205, 0206, …); two subagents must never both create the "next" migration. Every DB change gets
RLS-test coverage and keeps `pnpm db:test` green.

1. **Service-plan management** — UI + actions to create/edit service-plan lines on a machine and **apply a
   service template** to a machine (owner/manager). Respect RLS.
2. **Service-due notifications** — enqueue in-app notifications for **due-soon/overdue** services, a **weekly
   digest**, and a **stale-meter nudge**, honoring each farm's `settings` thresholds and quiet-hours.
   (In-app only — no WhatsApp.)
3. **Nightly recompute** — a scheduled path that runs `app.recalc_all_due()` (and fires C2's enqueues) daily.
   Implement as a Supabase scheduled function / SQL cron or a documented Vercel Cron hitting a service-role
   route; wire it and document the setup in `CLAUDE.md`.
4. **RR-admin console depth** — cross-farm **usage/adoption stats** (machines, active users, job cards, last
   activity per farm), **impersonation that writes an `audit_log` entry** every time an admin acts into a farm,
   and **service-template library** management (create/edit templates admins can apply in C1).
5. **VAT-inclusive entry** — let users type a VAT-**inclusive** amount that converts to stored **ex-VAT cents**
   using the farm's `vat_rate`, with the split shown. Keep storage integer-cents ex-VAT; no float drift.
6. **Report exports** — complete the export set beyond the existing cost CSV: CSV for each report family **and**
   **PDF** where printable (see PDF note). Farm-scoped by RLS.
7. **Bulk machine import** — CSV upload → validated preview → insert, with clear per-row errors, farm-scoped.
8. **Exclude retired/sold** from all dashboard/report/alert counts and the notification engine (coordinate with
   the dashboard rebuild in B).
9. **PDF generation** — printable **job card** and **machine file** (history) PDFs. Prefer a light server-side
   approach; keep it off the critical first-load bundle. Reuse the auth/RLS guards.

---

## Orchestration protocol (how you run Opus, in detail)

**Dependency gates (respect the order):**
1. Baseline green (Step 1) → 2. Plan written (Step 2) → 3. **Workstream A merged** → 4. Workstream B surfaces
   in parallel. **Workstream C can start right after the plan** (it barely touches B's files) and run alongside
   A/B — except any C task whose UI lives on a B surface, which waits for that surface.

**Spawning a builder — give every Opus subagent a task spec with all of:**
- **Goal** (one sentence) and the **scope item** it satisfies (cite SCOPE/CLAUDE).
- **Exact files/paths it owns** (and an explicit "touch nothing else").
- **The non-negotiable constraints** above that apply (paste the relevant ones — don't assume it read them).
- **Acceptance criteria** it must self-verify before reporting done.
- **"Leave the repo green"**: run `pnpm typecheck && pnpm build && pnpm lint` (and `pnpm db:test` if it touched
  the DB), and **commit** on its branch/worktree with a clear message.
- Its **branch/worktree**: parallel streams use `isolation: "worktree"`; branch off
  `claude/week-1-foundation-o9e7i8`.

**Parallelism rules:** partition strictly by file-ownership; never two writers on one file at once. Serialize
all migration-creating tasks through one ordering. If two tasks must touch a shared file (e.g. the i18n
`en.json`, the layout, the component kit), either serialize them or make one own the file and have others hand
it string keys / requests.

**Review loop (this is the core of your job):** when a subagent reports done, **read the actual diff** and
check it against: the acceptance criteria; the mission (does it move us toward modern/aesthetic/mobile+desktop
and scope-complete?); the non-negotiables (RLS, cents-ex-VAT, zero-anon-QR, §13/deferred, i18n, lean bundle);
mobile **and** desktop rendering; and no regression (re-run the gates yourself). If anything's off, **SendMessage
the subagent specific, actionable corrections** and re-review — iterate until it genuinely passes. Only then
integrate.

**Integration:** merge the worktree/branch back into `claude/week-1-foundation-o9e7i8`, resolve conflicts, and
**re-run the full gate set on the integrated tree** (`pnpm typecheck && pnpm build && pnpm lint && pnpm db:test`).
Commit coherent increments — never a giant blob, never a broken intermediate.

**Branch, commit, PR discipline:** all final work lands on `claude/week-1-foundation-o9e7i8`. Commit messages
are clear and descriptive. When the mission is done and pushed (`git push -u origin claude/week-1-foundation-o9e7i8`,
retry on network error with 2/4/8/16s backoff), ensure an **open draft PR** exists for the branch (create one
if not; mirror any PR template). Do not push to `main` or any other branch.

## Review & acceptance — the definition of done

Do not declare the mission complete until **all** hold, and you've verified each yourself:
- **Scope-complete:** every v1 surface in §4 works end-to-end; Workstream C items 1–9 are built and RLS-safe;
  nothing from §13 or the deferred list was built.
- **Design bar:** every surface uses the design system; mobile and desktop are **distinctly** and correctly
  laid out; the dashboard is a real overview with KPIs, trends, and drill-downs; empty/loading/error states
  everywhere; AA contrast, focus states, ≥44px targets.
- **i18n:** `en.json` and `af.json` both complete for every key; the app renders correctly in Afrikaans.
- **Green & lean:** `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm db:test` all pass on the integrated
  tree; RLS isolation still proven; the first-load bundle hasn't ballooned (report the numbers).
- **Runtime-verified:** smoke-test the key flows against the running app (dev server; use the live Supabase if
  wired) — login, dashboard, a machine's history timeline, a job card with autosave, a fault with a voice note,
  a report export/PDF, an admin stat + impersonation audit entry.
- **Docs:** update the "current status" block in `CLAUDE.md`; keep `docs/WORKPLAN.md` reflecting what shipped.
- **Delivered:** pushed to `claude/week-1-foundation-o9e7i8`; draft PR open/refreshed.

## Reporting cadence

Keep a live checklist in your replies to the user. Report at each milestone: baseline established; plan ready
(and any blocking question); Workstream A merged; each B surface and C item integrated (one line each — what
shipped, gates green); and a final summary with the verification results, bundle numbers, and the PR link.
Surface genuine blockers early via **AskUserQuestion**; don't narrate every subagent round.

**Begin now: ground yourself (Step 1), then write `docs/WORKPLAN.md` (Step 2), then start orchestrating.**
