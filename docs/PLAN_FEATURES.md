# Plan features: what the website sells, what the app enforces

Audit of 4 November 2026, against the website published that day
(RapidRiseAi/fleetwise-website `24a0ac9`, `src/shared/pricing.mjs` and `software.ts`) and
the founder decisions of 29 October 2026. The single source of truth for gates is
`src/lib/entitlements.ts` (`FEATURE_MIN_PLAN`), mirrored by `app.feature_min_rank` in SQL.

A gate is enforced where the data is read or written (page, action, export route, RPC),
not by hiding a menu item. Gates on a resource (a machine, a budget) use the plan of the
resource's own farm (`farmAllows` in `src/lib/auth.ts`), not the farm the person has
selected. Rapid Rise staff and workshops bypass farm plan gates; RLS still decides what
they can read.

> **Updated 14 November 2026 (task A1, migrations 20261114090000 to 20261114090300).** The
> matrix is now plan x profile x feature: `CAPABILITY_MIN_PLAN` and `PROFILE_REFUSES` in
> `src/lib/entitlements.ts`, mirrored by `app.feature_min_rank` and `app.profile_refuses`, and
> enforced at the tables that record the work. The rows below that predate it are kept and
> corrected where they changed.

## Prices (current list launch-2026-11-eq, 20261114090300)

| Plan | Full space / month | Full space / year (stated) | Minimum | Included equipment | Extra equipment |
|---|---|---|---|---|---|
| Essential | R49 | R490 | 5 spaces: R245 / R2 450 | 2 | R15 a month or R150 a year each |
| Professional | R79 | R790 | 5 spaces: R395 / R3 950 | 5 | R15 a month or R150 a year each |
| Complete | R99 | R990 | 5 spaces: R495 / R4 950 | 15 | R15 a month or R150 a year each |
| Done-For-You | quoted, from R170 | quoted | R2 500 a month | quoted | quoted |

Renewal: full spaces x rate + max(0, equipment in use - included) x equipment rate, once per
customer subscription across its sites. Self-service sign-up takes 5 to 200 full spaces;
more is a capacity check and a quote (not an equipment cap). `src/lib/billing/calculator.ts`.

## Support equipment (the equipment profile)

| | Full fleet asset | Support equipment |
|---|---|---|
| Who | cars, bakkies, trucks, tractors, harvesters, forklifts, any self-propelled vehicle; equipment may choose it | pumps and generators, compressors, workshop tools, implements, trailers, other non-self-propelled equipment (`app.equipment_eligible`) |
| Register, photos, written location, readings, service reminders, faults, checklists, repair jobs and costs, documents, QR, sale and warranty packs, chat | every plan | every plan |
| Driving log | every plan | never |
| Trips (scheduling, loads, trip money) | Professional and Complete | never; a trailer may be named on a vehicle's trip |
| Maps, routes, positions, tracking | Complete, once the `map` flag is released | never |
| Fuel, licence discs and road permits, detailed tyre fitment, loans and leases | fuel Professional; the rest every plan | never |
| TCO, cost per hour or km, budgets, depreciation | Professional and Complete | never (repair spend stays, labelled apart in reports) |

Every refusal is a trigger on the table, whatever writes it (screen, offline replay,
assistant, WhatsApp, import, API, tracker feed): `equipment_restrictions.sql`.

## Feature placement

| Website claim | Tier | App enforcement | Status |
|---|---|---|---|
| Asset register, photos, CSV import | All | ungated core | OK |
| Hours, km, operator records, driver activity | All | ungated core; the driving log is refused for support equipment | OK |
| Trip scheduling, loads, deliveries, trip income and expenses | Professional (decision 16) | `trips`: trips page, and the tables refuse a new trip, load or trip money below Professional (20261114090200) | **Changed**: trips were on every plan |
| In-app maps, route planning, positions, driving paths | Complete (decision 18) | `maps` plus the `map` flag: `mapsAvailable` on every screen, route and the positions endpoint; the tables refuse a planned route or position below Complete | **Changed**: the map flag was the only gate |
| Service schedules and reminders | All | ungated core | OK |
| Faults, inspections, checklists | All | ungated core | OK |
| Job cards and workshop collaboration | All | ungated core | OK |
| Parts, stock, service kits | All | ungated core (role + stock grant) | OK |
| Tyres and warranties | All | ungated core | OK |
| Sale, warranty and machine compliance packs | All | ungated; the sale pack's cost section is `tco` on the machine's farm | OK (gate moved to the machine's farm) |
| Printable QR labels, selected offline capture | All | ungated; QR fuel capture is `fuel` | OK |
| Users, roles, permissions, no seat fee | All | ungated | OK |
| Finance, lease and contract records | All (finance permission) | `can_view_farm_finance`; exports `advanced_reports` in `asset-finance-export.ts` | OK |
| Attachment storage max(2 GB, 100 MB a full space + 25 MB an equipment space), pooled per customer, R49 10 GB blocks | All | `app.storage_allowance` behind every upload reservation (20261118120000); blocks through A2 quotes and on the bill (20261118120100) | **Built** (A3): warnings 80/95%, only new attachments stop at full, automatic blocks off by default with an owner ceiling; no transfer charges |
| Fuel capture, consumption, alerts | Professional | `fuel` on page, actions, driver home, QR, CSV, SARS logbook | OK |
| Total cost of ownership, cost per hour or km | Professional | `tco`: machine list column, machine page (overview figure, lifetime stats, repair ratio), machine file PDF cost per hour, sale pack cost section | **Fixed**: these relied on cost visibility alone |
| Budgets and replacement insights | Professional | `tco`: machine page budgets card; add, edit and delete budget actions on the budget's own farm | **Fixed**: the actions had no plan gate and checked the role on the selected farm |
| Book value (depreciation register) | Professional | `tco`: report page, policy action, and `farm_book_values` RPC | **Fixed** (20261104220000): the RPC returned the register on any plan |
| Dashboards and advanced reports | Professional | `dashboard`, `advanced_reports` on pages and every report CSV/XLSX | OK |
| Scheduled reports | Professional | `advanced_reports` | OK |
| Accounting exports (journal, chart of accounts) | Professional | `advanced_reports` on `/accounting` and both CSV routes | OK |
| Expenses, suppliers, purchase orders, recurring expenses, cash flow, banking, reconciliation, statements, VAT tools | Professional (website "books" card) | **workshop-partner tools** (`financials`, partner product); a farm user is redirected away | **Website overclaim**: corrected in the website branch `claude/plan-accuracy` |
| Fleet compliance evidence pack | Complete (website) | `advanced_reports` (Professional), as the 29 October decisions place it | Website understates: corrected to Professional in the website branch |
| Consolidated management across sites, customer-wide reporting | Complete | `multi_site`: `/sites` combined view and its CSV, figures only for the person's own farms on Complete or above | **Built** 4 November (it did not exist) |
| Slots pooled across a customer's sites, one minimum per customer | Every plan (decision 22) | `farms.billed_through` (20261107150000); full spaces, the minimum and included equipment pool once through the main site (20261114090300) | **Built** |
| AARTO fines and driver nomination | Complete | `aarto` on page and actions | OK |
| AI assistant and voice | Complete | `voice_ai` in `assistant/context.ts` for every assistant route | OK |
| WhatsApp | Complete | `whatsapp_member` requires the plan rank in SQL | OK; voice notes and photos built 4 November, not yet released |
| AI usage at cost +30% | Complete | AI ledger and invoicing (docs/AI_USAGE.md) | OK |
| WhatsApp provider cost +30% | Complete | held and settled on the AI ledger under the customer's spending limit (20261118120200); free messages R0 | **Built** (A3), off until Rapid Rise sets the start date and the account's rates on /admin/ai; owner acceptance on /settings/ai; real-phone delivery unverified (B4) |
| One monthly spending limit for paid AI, voice and WhatsApp | Complete (assistance eligibility) | `assistance_budgets` per customer, chosen by the owner, no default (20261118120200) | **Built** (A3): existing businesses keep their limit as their choice |
| Human fleet management | Done-For-You, quoted | no catalogue price; quote-only (20261104200000) | OK; accepted-quote recording is open |
| API access | Done-For-You | `api_token_resolve` returns `api_allowed` from the plan; settings page and actions | OK |
| Hardware, tracking and provider feeds | Done-For-You | `configure_driver_connection` and `ingest_driving_event` check the plan | **Fixed** (20261104220000): a feed could be switched on, and kept receiving, on any plan |

## After a downgrade (decision 37, task B3)

Saved records of a feature the plan no longer includes stay readable and exportable by the
people whose role and site already allowed it; nothing new is collected, no analysis is
worked out afresh, and no paid provider is called. Where each stands:

| Feature | What stays | What stops | Where enforced |
|---|---|---|---|
| Trips (Professional) | trip list and pages, loads, deliveries, income and expense records; in the business export | new trips, loads and money; starting a planned trip; editing; the trip earnings report and a trip's result; a trip already underway can still be finished and a planned one cancelled | `trips` on pages and actions; `app.trips_history_guard` and its siblings (20261119090000) |
| Maps and tracking (Complete + `map` flag) | a trip's saved stops, planned distance and recorded positions, as text and a CSV, without a map | new positions, routes, redrawn routes, a delivery's location; tracker feeds answered `maps_unavailable` | `mapsAvailable`; `app.require_maps_ready` in the database (20261119090000) |
| Fuel (Professional) | the newest 200 draws and deliveries read-only on /fuel; all of them in the export | balances, consumption, anomalies, new draws (also a draw queued offline before the downgrade) | `fuel` on pages and actions; `apply_offline_capture_once` (20261119130000) |
| AARTO fines (Complete) | the newest 200 fines read-only on /fines; all in the export | new fines, nomination, deadline reminders | `aarto`; reminders by plan (20261119100000) |
| Dashboards, advanced reports, TCO, budgets, depreciation, consolidated sites, accounting exports | the underlying records (machines, costs, budgets) and the business export | the analysis itself and scheduled reports | existing gates; scheduled reports check the plan at claim time (20261013110000) |

The business export (`/api/farm/export`) is the exit route for every plan: it holds the raw
records of every feature above and none of the higher plan's analysis.

## Also fixed in this audit

- Every CSV export neutralises cells that begin like a spreadsheet formula
  (`csvCell` in `src/app/(app)/reports/data.ts`): a machine named `=HYPERLINK(...)`
  opened as a formula on the bookkeeper's computer.
