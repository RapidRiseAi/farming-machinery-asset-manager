# FleetWise

A multi-tenant PWA for South African farms and the contractors who service them. Built
mobile-first for a mid-range Android on poor signal.

> **Source of truth for scope:** [`docs/SCOPE.md`](docs/SCOPE.md).
> **Contributor guide and full build history:** [`CLAUDE.md`](CLAUDE.md).

## What it does

It is two products sharing one spine, because the farm and the workshop are two sides of the
same job.

**For the farm** — a register of every machine with QR stickers on them; service schedules
that come due by hours, kilometres or calendar; job cards that lock once approved; faults a
driver can raise from a sticker without an account; diesel with per-machine consumption and
theft/leak detection; costs and true TCO; budgets, utilisation and downtime; parts, service
kits and stock that knows what the next month of services has already spoken for; licences,
roadworthy and warranty expiries; AARTO fines nominated against the driver who was in the
seat; and the whole thing in English or Afrikaans, working offline.

**For the contractor** — one login that reaches every farm they serve, with their own
letterhead on quotes and invoices; corrections done properly (void, credit note, debit note,
revision, write-off, refund); customer statements and supplier statements; a VAT return on
the invoice basis with real SARS periods; expenses, suppliers, purchase orders and bank
reconciliation; recurring invoices and expenses; and profit, cash flow, debtors and
creditors.

A farm chooses what a connected contractor may see, and the default is the minimum: the
vehicles they are actually working on. They never see the farm's other contractors.

## Stack

Next.js (App Router) PWA · TypeScript · Tailwind · Supabase (Postgres + Auth + Storage),
with row-level security as the sole guarantor of tenant isolation.

## Local development

```bash
pnpm install
cp .env.example .env.local     # fill in Supabase values
pnpm dev                       # http://localhost:3000
```

The build succeeds without any environment set — env is read lazily — so a preview deploy is
always possible. Auth and data need real values at runtime.

## The RLS gate

This is the part to understand before changing anything.

Tenant isolation is enforced by row-level security and **proven by tests before a feature is
built on top of it**. Not by application checks, not by careful query writing — by policies,
demonstrated. The suite runs as real Postgres roles and asserts what each persona can and
cannot read, including the cases that matter most: cross-tenant reads, anonymous reads, an
operator who may see only their assigned machines, and a contractor who may see only the
work assigned to their own workshop.

```bash
pnpm db:test    # build a database FROM the migrations, then run every isolation suite
pnpm db:seed    # migrations + the demo farm (Weltevrede Boerdery, 12 machines)
```

`db:test` runs four files — `rls_isolation.sql`, `public_api_and_qr.sql`,
`post_release_popia.sql` and `selected_farm_administration.sql` — currently **60 assertion
sections**. It drops and recreates the database named by `TEST_DB_NAME`, so give concurrent
runs different names or they will destroy each other.

Migrations are plain SQL in `supabase/migrations/`, applied in filename order. Two rules
that are easy to get wrong and expensive to miss:

- An `app`-schema function with **no explicit grant defaults to `EXECUTE TO PUBLIC`**. Revoke
  it, and *measure* with `has_function_privilege`.
- Money is **integer cents, ex-VAT**, everywhere. Never `toLocaleString` — Node's trimmed ICU
  renders `en-US` while the browser renders `en-ZA`, which makes server and client HTML
  disagree and throws the page away on hydration.

## Environment

Everything the code reads is documented in [`.env.example`](.env.example). The essentials:

| Variable | Scope | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | all | Supabase project API URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | all | Supabase anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | server | Service-role routes (public QR, admin, cron). **Never** expose to the browser. |
| `NEXT_PUBLIC_SITE_URL` | all | Public site URL (magic-link redirects) |
| `CRON_SECRET` | server | Bearer token the nightly cron requires |
| `RESEND_API_KEY` · `EMAIL_FROM` | server | Sending documents and statements |
| `VAPID_*` | server | Self-hosted Web Push. Unset = push silently disabled. |
| `SENTRY_DSN` | server | Optional. Unset = errors go to the server log instead. |

Anything not set degrades to a no-op rather than an error: no DSN means errors go to the
log, no VAPID means no push, no billing provider means nothing charges anyone.

## Deploying

A standard Next.js project — Vercel auto-detects it (pnpm via the `packageManager` field).
Set the variables above, and schedule `/api/cron/nightly` (see
[`docs/CRON.md`](docs/CRON.md)); it runs thirteen maintenance and alert
engines, then any due report schedules, then push delivery. Authenticated by `CRON_SECRET`;
a failing step is reported and the pass continues.

## Project layout

```
src/app          routes — (auth) login · (app) authed shell · (public) QR + customer documents
                 admin · api (service-role routes, /api/v1 public API, cron)
src/components   the UI kit and feature components
src/lib          supabase clients, auth and entitlements, i18n (en/af), PDF engine,
                 money/format helpers, domain logic
supabase         migrations · tests (the RLS suites) · seed (demo farm)
docs             see below
```

## Documentation

| | |
|---|---|
| [`docs/SCOPE.md`](docs/SCOPE.md) | What v1 is, and §13 what it deliberately is not |
| [`docs/FLEETWISE_STATUS_CHECKLIST.md`](docs/FLEETWISE_STATUS_CHECKLIST.md) | Every requirement, with its real state |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Why RLS is the sole guarantor, and how it is proven |
| [`docs/POPIA.md`](docs/POPIA.md) | Personal data held, lawful bases, retention, data-subject rights |
| [`docs/BACKUP.md`](docs/BACKUP.md) | PITR runbook, RPO/RTO, restore drills |
| [`docs/SCHEMA_DRIFT.md`](docs/SCHEMA_DRIFT.md) | Checking the live database against this repo, and the false positives that will fool you |
| [`docs/CRON.md`](docs/CRON.md) | The nightly job and how to wire it |
| [`CLAUDE.md`](CLAUDE.md) | House rules and the full decision history, wave by wave |
