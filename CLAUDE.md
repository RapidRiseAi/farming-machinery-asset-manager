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
**Phase: Week 1 — Foundation.** Building strictly in §10 order.

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
- **App layer (build-verified in CI; runtime-verify pending hosted DB):**
  auth (email + magic-link, `/auth/callback`, session guards, `lib/auth.ts`);
  RR admin console (`/admin/farms` create + tier/status, farm detail);
  machine registry CRUD (`/machines` list/filter/search, new, edit).
- README with Vercel deploy env-var notes.

Blocked:
- **Hosted Supabase dev project** — `create` AND `restore` both blocked by the org's
  free-tier 2-project limit; my tools can't delete a project. Needs a slot freed
  (delete a project or upgrade in the Supabase dashboard). Until then the app-layer
  code above is build-verified only. Migrations/RLS/seed all proven on local PG.
- **Do NOT push to `main`** (production/Vercel) until the hosted DB is wired and the
  app is runtime-verified — per owner instruction.

Next (in order):
- Free a Supabase slot → create project → apply migrations + buckets + seed → wire env
  → runtime-verify auth/admin/machines.
- Machine photos/docs (Storage + client compression) → users/invites → meter readings
  → QR generation + public-lite page. Then RR admin impersonation-logged.

> Update this "current status" block at the end of every session.
