# FarmGear — Farm Machinery & Vehicle Manager

Multi-tenant PWA for South African farms to manage machinery: registry, QR codes,
service scheduling, job cards, faults, costs, dashboards, and WhatsApp alerts.

> **Source of truth:** [`docs/SCOPE.md`](docs/SCOPE.md). Contributor guide: [`CLAUDE.md`](CLAUDE.md).

## Stack
Next.js (App Router) PWA · TypeScript · Tailwind · Supabase (Postgres + Auth +
Storage) with row-level security for multi-tenancy.

## Local development
```bash
pnpm install
cp .env.example .env.local     # fill in Supabase values
pnpm dev                       # http://localhost:3000
```

## Database & the RLS gate
Migrations are plain SQL in `supabase/migrations/` (Supabase-compatible). Tenant
isolation is enforced by RLS and **proven by tests** before features are built on it.
No Docker needed — everything runs against a local Postgres:
```bash
pnpm db:test    # apply migrations + run the RLS isolation suite
pnpm db:seed    # apply migrations + the demo farm (Weltevrede Boerdery, 12 machines)
```

## Deploying to Vercel
The app is a standard Next.js project — Vercel auto-detects it (pnpm via the
`packageManager` field). Set these environment variables in the Vercel project:

| Variable | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | all | Supabase project API URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | all | Supabase anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | Used by service-role routes (QR submit, admin). **Never** expose to the browser. |
| `NEXT_PUBLIC_APP_NAME` | all | Optional; defaults to `FarmGear` |
| `NEXT_PUBLIC_SITE_URL` | all | Public site URL (magic-link redirects) |

The build succeeds without these set (env is read lazily), so a preview deploy is
always possible — but auth and data features require them at runtime.

## Project layout
```
src/app        routes: (auth) login, (app) authed shell, admin, api, public QR
src/lib        supabase clients, auth helpers, i18n (en/af + t())
supabase       migrations · tests (RLS isolation) · seed (demo farm)
```
