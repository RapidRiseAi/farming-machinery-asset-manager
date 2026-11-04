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

## Prices (website = app since migration 20261104200000)

| Plan | Per asset / month | Annual (10 months) | Minimum |
|---|---|---|---|
| Essential | R49 | R490 | 5 slots: R245 / R2 450 |
| Professional | R79 | R790 | 5 slots: R395 / R3 950 |
| Complete | R99 | R990 | 5 slots: R495 / R4 950 |
| Done-For-You | quoted, from R170 | quoted | R2 500 a month |

## Feature placement

| Website claim | Tier | App enforcement | Status |
|---|---|---|---|
| Asset register, photos, CSV import | All | ungated core | OK |
| Hours, km, operator records, driver activity | All | ungated core | OK |
| Service schedules and reminders | All | ungated core | OK |
| Faults, inspections, checklists | All | ungated core | OK |
| Job cards and workshop collaboration | All | ungated core | OK |
| Parts, stock, service kits | All | ungated core (role + stock grant) | OK |
| Tyres and warranties | All | ungated core | OK |
| Sale, warranty and machine compliance packs | All | ungated; the sale pack's cost section is `tco` on the machine's farm | OK (gate moved to the machine's farm) |
| Printable QR labels, selected offline capture | All | ungated; QR fuel capture is `fuel` | OK |
| Users, roles, permissions, no seat fee | All | ungated | OK |
| Finance, lease and contract records | All (finance permission) | `can_view_farm_finance`; exports `advanced_reports` in `asset-finance-export.ts` | OK |
| Attachment storage 100 MB per paid asset, min 1 GB | All | **not metered or enforced** | Open: approved terms are billed only once metering works (founder decision) |
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
| Slots pooled across a customer's sites, one minimum per customer | Complete (website FAQ) | **not built**: one subscription per farm, five-slot minimum per farm | Open: needs a billing-customer grouping above farms. Until then multi-site customers are quoted and set up by staff |
| AARTO fines and driver nomination | Complete | `aarto` on page and actions | OK |
| AI assistant and voice | Complete | `voice_ai` in `assistant/context.ts` for every assistant route | OK |
| WhatsApp | Complete | `whatsapp_member` requires the plan rank in SQL | OK; voice notes and photos built 4 November, not yet released |
| AI usage at cost +30% | Complete | AI ledger and invoicing (docs/AI_USAGE.md) | OK |
| WhatsApp provider cost +30% | Complete | **not metered** | Open: no paid WhatsApp traffic should run until metered |
| Human fleet management | Done-For-You, quoted | no catalogue price; quote-only (20261104200000) | OK; accepted-quote recording is open |
| API access | Done-For-You | `api_token_resolve` returns `api_allowed` from the plan; settings page and actions | OK |
| Hardware, tracking and provider feeds | Done-For-You | `configure_driver_connection` and `ingest_driving_event` check the plan | **Fixed** (20261104220000): a feed could be switched on, and kept receiving, on any plan |

## Also fixed in this audit

- Every CSV export neutralises cells that begin like a spreadsheet formula
  (`csvCell` in `src/app/(app)/reports/data.ts`): a machine named `=HYPERLINK(...)`
  opened as a formula on the bookkeeper's computer.
