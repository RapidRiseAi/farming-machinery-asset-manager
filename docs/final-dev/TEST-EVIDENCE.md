# Test evidence

Task A6, BRIEF section 25 item 5. Exact commands, the environment they ran in, and what they showed.
This is what was observed, not a claim about production. Nothing here was run against the live
database, a real payment, a real phone or a provider.

## Environment

- Local: Windows 10 Pro, Node 24.16.0, pnpm 10.0.0, PGlite 0.5.16 (Postgres compiled to WebAssembly,
  a fresh database per suite), the lane A worktree at the A6 commits (`final/lane-a`, which holds
  everything on `final-dev` plus A6).
- CI (GitHub Actions, `ubuntu-latest`, Node 22):
  - "App quality gates + build";
  - "RLS isolation tests" (real Postgres 16, every suite on one shared database);
  - "Android debug build" (Temurin 21, Gradle 8.14.3, from B6).

## The gates, as run on 24 November 2026 (lane A, A6)

| Command | Result |
|---|---|
| `pnpm -s exec tsc --noEmit -p .` | clean |
| `pnpm -s test` | 1300 tests: 1299 pass, 0 fail, 1 skipped |
| `node scripts/migrate_check.mjs --suite` | 102 of 102 SQL suites pass; every migration applies in order to an empty database |
| `pnpm security:inventory` | 181 callable SECURITY DEFINER functions; 0 callable by anon; 0 without a pinned search_path; 13 flagged, all with a recorded reason |
| `pnpm -s build` | passes (a production Next.js build) |
| `pnpm -s run i18n:parity`, `i18n:keys`, `errors:check`, `design:lint`, `dashes:check` | all clean |
| `pnpm audit --prod --audit-level high` | no known vulnerabilities |
| eslint on every new and changed file (the `[id]` pages through ESLint's `lintText`, as the CLI hangs on them here) | clean |

The first unit run on 24 November found two real defects, now fixed:
- the dashboard's papers and warranty widgets read the real clock, so a test pinned at 5 November failed after 20 November;
- a placeholder password assignment in the new load-test doc.

The first SQL run found the cross-customer move rule breaking two suites whose fixtures used unlinked sites, now fixed.

## Mutation testing (a guard is broken on purpose, a test must fail, then it is restored)

| Task | Guards | Caught |
|---|---|---|
| B5 custom fields (SQL) | 10 | 10 |
| B5 import staging (SQL) | 31 | 31 |
| B5 manual questions (SQL) | 18 | 16. The other 2 mutations behave exactly like the original code: the attachments policy already confines pages to the person's businesses, and `EXECUTE` is revoked from people. |
| B5 document adapter, held call, manuals (TypeScript) | 9 + 11 | 20 |
| B6 queue, App Links, assetlinks, route gaps (TypeScript) | 13 | 13 |
| A6 final isolation suite | a wrong expectation; an anon grant | both caught |
| A6 move rule | the customer check removed | caught |

Earlier tasks recorded theirs in their own reports (REPORT-A1 to A5, B1 to B4).

## CI on `final-dev`, task by task

| Task | Integration commit | CI |
|---|---|---|
| A2, B2, B3 (R-044) | 051b34c, a0c24c5, 8c68bc4, fix 8fc7aae | passed |
| A3 | 90a057f | passed (both jobs) |
| B3 (rest) | cf1faf1, fix ef121c1 | passed |
| A4 | fe17ec5, time-zone fix c597ef4 | passed |
| B4 | 735ee3a | passed (both jobs) |
| A5 | 9843904 | passed (both jobs) |
| B5 | ca29985 | passed (both jobs) |
| B6 | be20517, fixes a9253e5, 1fc3bfd | passed on 1fc3bfd (app, RLS, Android debug build with merged-manifest checks; artifact `fleetwise-android-debug`) |
| A6 | see MASTER-PLAN | at integration |

## Not run, and why (scenarios that need what does not exist yet)

| Check | Needs |
|---|---|
| `pnpm ui:check`, `ready:check`, `voice:check` on the screens added in this project | a running app with a populated test business; run against staging or the live site after release |
| Load tests (scenario 42) | a staging project (docs/LOAD_TESTS.md) |
| Restore drill (scenario 39) | the offsite copy's secrets and a scratch project (BACKUP.md section 9) |
| Email journeys end to end (scenario 38) | staging and a real inbox |
| Real payment, decline and refund paths | Paystack test mode on staging |
| Android on a phone | a phone and the Play account (docs/ANDROID.md test list) |
| WhatsApp photos and voice on a real phone | the production number and a phone (REPORT-B4) |
| The website published | the founder's approval (A5) |

## Screenshots

The revised plan review PDF (A5) was rendered and inspected page by page, and the website's
browser scripts took screenshots (REPORT-A5). No screenshots of the app's new screens exist:
that needs the running app with a populated test business, which is the `ui:check` row above.
