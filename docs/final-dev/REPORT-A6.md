# REPORT A6: security read, backups, load tests, release notes, final deliverables

Lane A, branch `final/lane-a`, 19 to 24 November 2026, from `266a8e5` (synced with B6 at `228f388`). Built by the main Claude session. BRIEF sections 20, 21, 24 and 25; scenarios 37, 38, 39 and 42. Nothing was pushed to `main`, applied to a live database or released by this work.

Gates (24 Nov, lane A): tsc clean; 1299 unit tests pass (1 skipped); 102/102 SQL suites on PGlite; `pnpm security:inventory` clean; `pnpm build` passes; statics and audit clean. Details and mutation results in docs/final-dev/TEST-EVIDENCE.md. CI on real Postgres runs at integration.

## 1. Done

| Part | What was done | Where |
|---|---|---|
| Privileged functions (S20) | Every SECURITY DEFINER function a person can call is listed from a migrated database. There are 181; none is callable by anon, and every one has a pinned search_path. 13 name no access check in their own body. All 13 are in schema `app`, which PostgREST does not expose, and each has its reason recorded. The only search_path-less functions are pg_trgm's own. An IDOR scan covered functions taking a business id plus another id: all 9 were read in full and tie the extra id to the business, or are staff-only. CI now runs `pnpm security:inventory`, so a new function cannot ship unread. | `scripts/security_inventory.mjs`, SECURITY-INVENTORY.md, security-open-functions.json |
| Isolation across the schema | The catalogue has no table without row security, nothing granted to anon, and no policy for anon. Every read policy uses an access helper; the five open ones are listed with reasons. On the new tables, nine kinds of person see exactly what they should: owner, operator, switched-off account, ended membership, another site of the same customer, partner, Rapid Rise with and without the second factor, and another business. Switched-off sessions are refused by the new write functions. The suite was proven to fail on a wrong expectation and on an anon grant. | `supabase/tests/final_isolation.sql` |
| **Finding fixed: moves across customers** | `move_machine_to_site` let anyone who runs two sites move a vehicle between them, even when the sites belong to different customers. That quietly moved the vehicle's space to the other customer's bill. The brief requires an explicit handover between customers. A move now needs both sites to share a billing root. The two move suites now link their own sites and assert that the refusal leaves no trace; mutation caught. | migration `20261121130000` |
| **Finding fixed: switched-off accounts at the door** | `/api/chat`, `/api/machines/search` and `/api/assistant/consent` accepted a deactivated profile. The database refused the reads anyway, but consent wrote the person's own row. All three now refuse an inactive account, as pages already did. | three routes |
| **Finding fixed: a scheduler secret compared in plain time** | `/api/push/send` compared its bearer with `!==`, while every other scheduled route used the constant-time check. A test now holds every scheduled route to a constant-time check. | `src/lib/security/cron-auth.test.ts` |
| **Finding fixed: the dashboard used the real clock** | The papers and warranty widgets read the real clock while every other widget used the dashboard's own `now`. A test pinned at 5 November failed once the date passed 20 November. | `src/lib/compliance.ts`, `src/lib/dashboard/compute.ts` |
| Other S20 surfaces read | All found sound: CSV export neutralises formulas; raw HTML is server-made QR SVG and nonce scripts; Paystack and WhatsApp webhooks verify signatures over the raw body; only chat is in realtime; the auth callback validates `next` and names the other-browser case; email confirm needs a button and a well-formed token; reset neither enumerates accounts nor skips its rate limit and captcha; App Links (B6). | |
| Backups (S21) | `scripts/restore_drill.mjs`: run against an isolated project only. It refuses production and is blocked without its inputs. It counts key tables and checks a sample of finished uploads exists in the offsite copy, with sizes. BACKUP.md section 9 gives the drill step by step. The nightly file copy already exists; it waits for its secrets. | |
| Scheduler | Authentication pinned (above). Health already reports missing settings and late, unfinished or failed runs. Leases, retries and lifecycle stops are covered by the A2 to A4 suites. | |
| Load tests (S21) | `scripts/load_seed.mjs` (staging only): 200-space customers with equipment over three sites, a year of readings, chat. The k6 scenarios use the app's own session cookie: a working day with pooled-site readings, concurrent chat and real uploads, and the scheduled exports, billing and nightly passes. docs/LOAD_TESTS.md has the setup, what to record and a cost model from published prices. Nothing run: no staging project exists. | `load/k6/` |
| Deliverables (S25) | The requirement register is up to date: no row left M or C, and every item that waited on A6 has its result. All 41 decisions are mapped. Also: the limits catalogue generated from the code with a drift test; release notes (sequence, flags as released, rollback); the configuration checklist (every setting the code reads, no values, the smallest action); `.env.example` completed; customer guidance in EN/AF on recording routes and importing readings. | docs/final-dev |

## 2. Requirements and scenarios

| Covered | By |
|---|---|
| Scenario 37 (clean and upgrade migration paths, privileged-function and RLS regressions, no exposed service keys) | `migrate_check --suite`, `final_isolation.sql`, `security_inventory --check`, `deploy_compatibility.sql`, `pay_gate_functions.sql`. The service key stays server-only (`NEXT_PUBLIC_` holds only the URL and anon key). |
| Scenario 38 (reset, invite, magic link, deep link, removed-member sessions) | Code read (above); `final_isolation.sql` [3]; routes refuse inactive profiles; `native.test.ts` (App Links). End-to-end email journeys need staging and an inbox. |
| Scenario 39 (restore and separate media, alerts on failed scheduled work) | `restore-drill.test.ts` (refuses production, never passes blind); health's scheduler checks. The drill itself is blocked. |
| Scenario 42 (load and cost) | The kit and cost model; results empty on purpose. |

Register: R-032 E (fixed), R-070 to R-074 E (B1, now recorded), R-130 E, R-131 E, R-134 E, R-136 E, R-137 E; R-053, R-054, R-132, R-133 and R-135 X with the exact blocker.

## 3. Not done, and why

- **No staging project, so no load results and no rehearsal.** Founder action (LAUNCH_CHECKLIST Part 1).
- **No restore drill.** The offsite copy has no destination yet (three secrets), and there is no scratch project.
- **Email journeys end to end** (reset through to the new password and sign-in, invites, magic links) were read in code, not clicked, because that needs staging and a real inbox.
- **`ui:check` on the screens built in this project** (imports, fields, manuals and the trip gap note) needs a running app with a populated test business; not run.

## 4. Assumptions (flag any that are wrong)

1. A "customer" for moves is a billing root (`billed_through`). Two separately billed farms with the same owner are two customers, and move vehicles between them through the handover.
2. Functions in schema `app` granted to `authenticated` are internal, because PostgREST exposes only `public`.

## 5. Risks, most important first

1. **The move rule changes behaviour.** Anyone who moved vehicles between separately billed farms must now use the handover. Production holds only test accounts, so no customer is affected yet.
2. **Release size.** 30 migrations in one sitting (RELEASE-NOTES.md); the old build must not run long against the new schema.

## 6. External blockers

| Blocker | Smallest human action |
|---|---|
| Staging project | Create `fleetwise-staging` (LAUNCH_CHECKLIST Part 1); then docs/LOAD_TESTS.md |
| Offsite copy and drill | The three secrets (BACKUP.md 2.3) and a scratch project; then BACKUP.md section 9 |
| Provider settings | CONFIGURATION.md: Sentry, alert emails, Turnstile, AI credit and `AI_KEY_SECRET`, Speech S0, Vercel Pro |

## 7. For the final combined review

- Release with RELEASE-NOTES.md, in order, after the founder's approvals.
- FOUNDER-DECISIONS-PENDING items 1 to 14 stay open until answered.
