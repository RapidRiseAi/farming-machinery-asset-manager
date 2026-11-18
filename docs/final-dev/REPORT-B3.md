# REPORT B3: driving logs, trips and maps by plan; imports, repeat taps, offline gaps; history after a downgrade

Saved by the main session from the worker's final message (the worker's harness refused to write this file). Text unchanged apart from this line.

Lane B, branch `final/lane-b`, from `45e5efd` to `a68b0be`, 18 November 2026. Nothing was pushed, merged, applied or released.

Six additive migrations, `20261119090000` to `20261119140000`, each with a probe in `apply_pending.mjs` and its own suite in `run.sh`. All gates passed at the final commit: tsc, 1209 unit tests (1 skipped), dashes, i18n parity and keys, design lint, error coverage, and the full SQL suite (94 of 94 on PGlite). Each new guard was broken on purpose and a test caught it every time. Two cross-tenant and plan holes were found and closed: a trip could name a driver from another business, who could then read its loads and customers; and a diesel draw queued offline was saved after a downgrade.

## Done

| Step | Commits | What changed |
|---|---|---|
| R-044 check | Codex `799f60f` (merged `8c68bc4`) | Checked against the brief and built on. Written stops save with no coordinates on Essential (`manual_driving.sql`). |
| 1. Trips by plan | `72f7085`, `a694d6d`, `9b0d325`, `8952b2b`, `d69c107`, `e77f6f3` | **Migration `20261119090000`:**<br>• Below Professional, a saved trip, load, trip income or trip expense cannot be changed (`plan-feature-trips`).<br>• Three exceptions: cancel a planned trip, finish a trip already underway (with its deliveries), or soft-delete. Nothing else may change in the same update.<br>• A trip's driver must belong to the business. This closes the cross-tenant read.<br>**Trip actions** check the plan first, and a delivery is checked before any file is stored.<br>**`tripReport` (`src/lib/trips.ts`):**<br>• counts finished trips only and says how many cancelled or unfinished trips it left out<br>• works out per-km only from trips with both readings<br>• says when no income was entered and never divides by zero<br>• says it covers the last 90 days, and is Professional only<br>**Trip page:** shows income, expenses and the result after expenses on the phone. Below Professional it is a read-only record with a notice. |
| 2. Maps | `bed2801`, `b7b5c7e`, `e0ed02d`, `3ad3a86`, `0a8ebc7` | The `map` readiness flag is now enforced in the database (`app.maps_ready`, `app.maps_allowed`, `app.require_maps_ready`). A new or redrawn route and a new position need Complete plus the flag. A delivery keeps its location only when maps are allowed.<br>`/map` shows each position's age: "Reported 4 min ago" or "Last known position, 3 h ago". Nothing says "live".<br>After a downgrade, a tracker feed gets `403 maps_unavailable` instead of being told to retry.<br>`docs/ROUTING.md`: provider terms reread with quotations. |
| 3. Downgrade history | `16fcc7f`, `48e49c1`, `82b1a86`, `04967a3`, `b60a0c6`, `0d54b73` | • Saved diesel records and saved fines stay readable after a downgrade, with no analysis, nomination or reminders.<br>• A trip without maps shows its saved stops, planned distance and positions as text, plus `/trips/[id]/positions.csv`.<br>• The business export now streams page by page (up to 50,000 rows a table). It now includes trips, loads, trip money, routes, positions and fuel-card statements.<br>• Migration `20261119100000`: AARTO reminders only go where the plan includes AARTO and the business is open. |
| 4. Imports | `24b7d1f`, `3e7f4b6` | • Re-importing a row with no serial or registration that matches one already there (same name, type, make, model and year) is refused.<br>• Import refusals are translated codes, not raw English.<br>• The other section 19 checks were rechecked and already held. |
| 5. Repeat taps | `cc4ffc3`, `68afd5c`, `892c56f`, `ed9aae8`, `4b52d72`, `329d8b2`, `d924540`, `895c2df`, `4120892`, `cf512ad` | • **Work-request media** runs once per capture id. Before, the amount and note were recorded twice on a retry.<br>• **Assistant turn and AI transcription:** a new helper, `respondOnce`, gives a retry the first answer, so a lost answer is not paid for twice. A3's holds and refusals are unchanged. The voice session already did this.<br>• **Migration `20261119110000`:** a request claim can hold an answer up to 64 KiB, and claims older than two days are swept nightly.<br>• **Activation "Pay"** reopens the checkout already open (same Paystack page and reference). A2's payment attempt model is unchanged.<br>• **Contractor vehicle copy:** the claim was already in place; a test of two racing presses now proves it.<br>• **Migration `20261119120000`:** a service template is applied to a machine once, enforced by a unique index. |
| 6. Offline | `a8eeb37`, `cb0c740`, `7b963d4`, `8a0a2bf`, `8261d73` | • A queued capture keeps the request id of the failed online attempt.<br>• **Migration `20261119130000`, `apply_offline_capture_once`:** if the online save already landed, it answers "duplicate". If the online save is still running, it says "retry later". Otherwise it claims the id and saves the capture. It also checks the fuel plan again for a diesel draw.<br>• `claim_request` now answers "done" for an id that a queued capture already used.<br>• Plan and equipment refusals are no longer retried for ever. Each kept draft says why it was kept, in English and Afrikaans. |
| 7. Export, accounting, digest, empty states | `8a87bee`, `eb6404b`, `75d146f` | • **Migration `20261119140000`:** the accounting page's summary is now added up in SQL.<br>• The weekly digest goes once a week per open business. It is asked Monday to Wednesday, so a missed Monday catches up.<br>• Empty states now explain what to do.<br>• Suggested questions only fill the typing box and never send a paid turn; a guard test keeps it that way. |
| 8. Scenario 18 and docs | `0fde4de`, `d8456d1`, `9cbfae8`, `d54f133` | • New suite `sites_roles_consolidated.sql`.<br>• `PLAN_FEATURES.md` has a new "After a downgrade" section.<br>• Also updated: `DATABASE.md`, `CRON.md`, `LIMITS.md` (`positionRecentMs`, `tripReportWindowDays`), the register and `LAUNCH_CHECKLIST.md`. |

## Requirements and scenarios

| Requirement | State | Tests |
|---|---|---|
| R-044 | E, no device run yet | `manual_driving.sql` |
| R-045 | E, no browser walk yet | `trips_by_plan.sql` [13], `trips.test.ts` |
| R-046 | E, maps stay unreleased | `trips_by_plan.sql`, `map_features.sql`, `trip_routes.sql`, `map-data.test.ts` |
| R-051 | E | `trips_by_plan.sql` [17], `scheduled_work_by_plan.sql`, `offline_capture_once.sql`, farm export `route.test.ts` |
| R-060, R-061, R-064 | E | `manual_driving.sql`, `trips_by_plan.sql`, `trips.test.ts`, `trip_routes.sql` |
| R-062 | X, waiting on the Mapbox read | `ROUTING.md` citations, `place_search.sql` |
| R-120 | E | `csv.test.ts` |
| R-122 | E | work media `route.test.ts`, `request-claim.test.ts`, `request-id.test.ts`, `checkout-cancel.test.ts`, contractor `sync.test.ts`, `request_claim_answers.sql`, `service_template_once.sql` |
| R-123 | E | `offline_capture_once.sql`, `envelope.test.ts`, `sync-refusal.test.ts` |
| R-124 | C, B3's part done; A4 owns the complete export with files | `journal_summary.sql`, export `route.test.ts` |
| R-125 | E | `scheduled_work_by_plan.sql`, `starters.test.ts` |

Section 23 scenarios:
- **13:** `trips_by_plan.sql` [13], `manual_driving.sql`, `trips.test.ts`
- **17:** `trips_by_plan.sql` [17], `scheduled_work_by_plan.sql`, `offline_capture_once.sql`
- **18:** `sites_roles_consolidated.sql`, `sites-overview.test.ts`
- **35, web parts:** stale positions in `map-data.test.ts`, the global place-search slot in `place_search.sql`, offline replay in `offline_capture_once.sql`

Mutation results (each guard broken on purpose, then restored):

| Guard | Caught |
|---|---|
| Trips history guard | 1/1 |
| Scheduled work | 5/5 (the two digest guards back each other up, so they were removed together) |
| Import | 3/3 |
| Work media | 3/3 |
| `respondOnce` | 4/4 |
| Checkout resume | 3/3 |
| Contractor claim | 1/1 |
| Template index | 2/2 |
| Offline wrapper | 7/7 |
| Journal summary | 2/2 |

## Not done, and why

- **No browser or phone run.** There is no `.env.local` here. The new screens are type-checked and covered by unit and SQL tests only.
- **Budgets, TCO and depreciation after a downgrade** are readable through the business export only, not on a screen. Assistant and WhatsApp history after a downgrade is B4's.
- **Starting a trip does not copy the loads' drop-offs into the driver's written stop list.** It is a small follow-up in `trip_start`.
- **The accounting journal CSV** still builds in memory. It is capped at 100,000 lines and refuses beyond that.

## Assumptions

- After a downgrade, finishing a trip already underway or cancelling a planned one counts as completing what was in hand. Starting a planned trip counts as new use.
- A trip's result (income less its own expenses) is hidden below Professional. Its income and expense records stay readable.
- A position older than 10 minutes is shown as "last known". This is a display window, not a founder term.
- The weekly digest is not a plan feature. It stops only for a business that is not open.
- Paystack's documentation does not say how long a checkout page stays open (searched 18 November). The worst case is the old 30-minute "in progress" answer.

## Risks, most important first

1. **Mapbox route storage.** Mapbox's archived reference says routes "may be cached but may not be stored permanently" and may be shown "atop a Mapbox map". FLEETWISE stores the route with the trip and draws it on OpenFreeMap. The current terms could not be read.
2. **Map tiles.** OpenFreeMap gives no uptime promise.
3. **Essential businesses with trips underway** can finish or cancel them, but cannot start a planned trip.
4. **Complete businesses not in the map testing group** can no longer write positions or routes, even through the service. Three suite fixtures were updated to put their Complete farms in the testing group.
5. **Request claims.** `claim_request` was replaced with the same signature. Assistant answers now sit in `request_claims` for up to two days; they are swept nightly and are never readable by a signed-in person.
6. **Driver hours page.** It says "South Africa sets no number for this". That is a legal claim for A5's lawyer read.

## External blockers

- **Founder, before maps are released:** read the Directions section of Mapbox's current Product Terms (the 20 October 2026 PDF linked from mapbox.com/legal/product-terms). Answer one question: may a route be stored with a trip and drawn on a non-Mapbox map on our plan? If not, use our own route server or agree terms with Mapbox. Also choose the production tile source and set `MAP_STYLE`.
- **Release:** apply `20261119090000` to `20261119140000` before deploying the code.

## For the next tasks

- **A4:** the business export now streams page by page and includes trips, routes and positions. Build the complete export with files on top of it. Request claims are swept nightly.
- **B4:** web assistant turns are claimed by request id. WhatsApp calls `runAssistantTurn` directly and needs its own replay protection.
- **B6:** positions need Complete and the `map` flag in the database. A feed after a downgrade gets `403 maps_unavailable`. Queued captures should carry a `request_id` so a lost online save is recognised.
- **A6:** the new definer functions are service-role only, except `claim_request`, which was replaced and is already listed as open in `pay_gate_functions.sql`.
