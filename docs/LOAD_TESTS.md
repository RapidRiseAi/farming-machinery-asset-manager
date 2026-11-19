# Load tests

Task A6, 19 November 2026. BRIEF section 21 and scenario 42. Synthetic customers and k6 scenarios
for a **staging** project. Every script refuses the production address. **Nothing here has been run
yet:** no staging project exists (LAUNCH_CHECKLIST Part 1 "Supabase, free: a second project,
`fleetwise-staging`"), and k6 is not installed on the build machine. Results below are empty on
purpose. A green build is not a capacity result.

## What is measured

| Scenario (brief) | Script | What it does |
|---|---|---|
| 200-full-space customers with equipment | `scripts/load_seed.mjs` | Builds the fixtures. Each customer has 3 sites billed through the first, 200 full assets plus 50 equipment, an owner, a manager and 10 operators, a year of monthly readings, chat and the map flag. Everything is marked test and named `LOAD <run>`. |
| A working day, pooled-site writes | `load/k6/customers.js` | Every synthetic person signs in once with Supabase's password grant. They then use the app's own session cookie, the same one the browser holds. Each loop opens home (or the driver screen) and the asset list, searches assets, and records a meter reading at their own site through `record_meter_reading`. RLS and the pay gate apply as for a real phone. |
| Concurrent chat and uploads | `load/k6/chat_uploads.js` | People at each first site send messages to their group through `/api/chat`. Every third round, each also attaches a real PNG through the upload pipeline (`/api/uploads/begin`, the signed upload to Storage, `/api/uploads/finalise`), so pool reservations and chat ordering are both busy. |
| Large exports, billing jobs | `load/k6/jobs.js` | The scheduler's calls, one at a time: `/api/cron/exports` (one complete export per customer, made with `--exports`), the billing pass and the nightly pass. |
| Long audio, maps | not driven | Both spend money at the provider (Azure, OpenAI, Mapbox) and can only be measured against them, so they are not driven. Their cost is modelled below, and their correctness is already proven with stand-ins (`pnpm voice:check`; B3's routing tests). |

## Setup (founder, once)

1. Create the staging Supabase project (same region, eu-west-3). In the repo, apply every
   migration to it **only** (with `node scripts/apply_pending.mjs --apply` pointed at staging's
   connection string, never production's). Then run `node scripts/migrate_check.mjs --suite`
   to confirm the suites pass on this code.
2. Give a Vercel preview deployment staging's settings:
   - `NEXT_PUBLIC_SUPABASE_URL`, the anon key and the service role key, all staging's;
   - its own `CRON_SECRET`;
   - `BILLING_CHARGING_ENABLED` off, and Paystack **test** keys.

   Note the preview address (APP_URL).
3. Install k6 (k6.io/docs/get-started/installation).
4. Seed, from the repo, with staging's keys in the environment and never on the command line:
   ```powershell
   $env:STAGING_SUPABASE_URL = "https://<staging ref>.supabase.co"
   $env:STAGING_SERVICE_ROLE_KEY = "<staging service role key>"
   $env:LOAD_PASSWORD = "<12+ characters, for the synthetic people only>"
   node scripts/load_seed.mjs --yes-staging --customers 5 --exports
   ```
   This writes `load/.seed-manifest.json` (git-ignored; ids and emails, no password).

## Run

```powershell
$env:STAGING_ANON_KEY = "<staging anon key>"; $env:APP_URL = "https://<staging preview>"
k6 run --summary-export load/results-customers.json load/k6/customers.js
k6 run --summary-export load/results-chat.json load/k6/chat_uploads.js
$env:CRON_SECRET = "<staging's>"; k6 run --summary-export load/results-jobs.json load/k6/jobs.js
```

`VUS`, `RAMP` and `HOLD` change the shape (for example `-e VUS=120 -e HOLD=20m`). The default is
one virtual person per seeded person (60 for 5 customers). Thresholds:
- fewer than 1% failed requests (2% with uploads);
- 95th percentile under 2.5 s for pages, 1 s for API routes, 800 ms for database calls, 3 s for an upload step;
- each export run under the 300 s function limit.

## What to record (fill in after a run)

| Measure | Where | Result |
|---|---|---|
| Requests per second, p50, p95 and p99 per tag (`kind`, `name`) | k6 summary | |
| Failed requests and which checks failed | k6 summary | |
| Database CPU, memory, connections | Supabase, Reports, Database | |
| The slowest queries, with plans | Supabase, Query performance (pg_stat_statements); `explain analyze` on the top five | |
| Function duration and memory, timeouts | Vercel, Observability, Functions | |
| Throttling | Supabase Auth rate limits during sign-in; Storage upload errors | |
| Export run time per customer and archive size | `jobs.js` durations; `farm_export_jobs` | |
| Billing and nightly pass time | `jobs.js` durations | |

Clean up with `node scripts/load_seed.mjs --yes-staging --remove`, which deletes the sign-ins and
closes the businesses. Better still, reset the staging project.

## Cost model (estimates from published prices, not measurements)

Prices are those recorded in docs/AI_USAGE.md (provider rates, USD) and docs/ROUTING.md (Mapbox, read 18 November 2026). They change; the ledger prices each call from `ai_prices`. The customer pays cost plus the margin, within their own limit.

| Use | Unit price | Example |
|---|---|---|
| A ten-minute voice note, heard by the AI | gpt-4o-transcribe about $0.006 per audio minute | about $0.06 per note before the margin |
| The same note on the fallback | mai-transcribe-2 $0.10 per audio hour | about $0.017 |
| Live recognition while speaking | Azure $1.00 per audio hour + $0.30 enhanced | 10 minutes about $0.22 |
| An assistant answer | about $0.001 | 100 a day about $0.10 a day |
| Planning a route | Mapbox: 100,000 requests a month free, then $2.00 per 1,000 | the app stops at `ROUTING_MONTHLY_CAP` (95,000) before any charge |
| Map tiles | OpenFreeMap: no charge, no uptime promise | production tile source is a founder decision (FOUNDER-DECISIONS-PENDING 5) |
| A large export | Vercel function time (up to 300 s per run) and Storage reads | measured by `jobs.js` |
