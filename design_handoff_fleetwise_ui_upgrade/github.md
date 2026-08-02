repo: RapidRiseAi/farming-machinery-asset-manager
branch: main

## Last sync
date: 2026-08-01T20:10:00Z

### Updated in this project
- Rebuilt the farm dashboard, machines list, job card, machine detail the public QR + faults triage, the contractor portal, the costs/diesel screens, people/settings, login/onboarding, the RR admin console, a new driver/operator home, the owner inbox, traffic fines/AARTO, daily checks, the parts catalogue, alerts/notification preferences, the partner directory, the add-a-machine flow, the work/job-card list, the spreadsheet import, the RR service-template library, and the checklist question builder as separate mobile + desktop designs. Every route in the app is now covered.
- Modernised type (Instrument Sans, tabular figures) and density while keeping the repo's brand/sand/status colour tokens exactly.
- Documented 176 concrete UX faults across twenty-two screens — every route and every account type — with fixes; no backend changes.
- Flagged a security-shaped UX fault: contractor login URLs render as copyable plain text on /partners.
- Found two real code bugs: login t() is called with no locale (bilingual app opens in English for everyone), onboarding steps 1 and 3 share `machines > 0` so "print QR stickers" ticks itself; and `impersonateFarm` only writes an audit row without setting any farm context, so "Act into farm" does not actually enter the farm; and acceptQuote/approveInvoice commit real money with no confirmation step.
- Gated the irreversible POPIA erase action behind a type-the-name confirmation (was a ghost link).
- Added the missing delete confirmation (soft-delete wording + what else gets hidden) requested by the user.
- Note: the attached design-system project (8ce74cf4) is empty, so all tokens are grounded in the repo's own tailwind.config.ts.

## Screen map
| Project screen | Repo files it was built from |
|---|---|
| Shell (sidebar, top bar, mobile tabs) | `src/app/(app)/layout.tsx`, `src/app/layout.tsx`, `src/app/globals.css`, `tailwind.config.ts`, `src/components/ui/nav.tsx`, `src/components/ui/README.md` |
| S01 — Farm home (Owner/Manager), mobile + desktop | `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/dashboard/charts.tsx`, `src/components/ui/{card,stat,badge,empty-state,button,icons}.tsx`, `src/lib/money.ts` |
| S02 — Machines list, mobile + desktop | `src/app/(app)/machines/page.tsx`, `src/app/(app)/machines/loading.tsx`, `src/app/(app)/machines/new/page.tsx`, `src/app/(app)/machines/import/import-client.tsx`, `src/components/ui/{table,field,input,select,badge,empty-state}.tsx`, `src/lib/machine-options.ts` |
| S03 — Job card (mechanic), mobile + desktop | `src/app/(app)/jobcards/job-card-editor.tsx`, `src/app/(app)/jobcards/line-entry.tsx`, `src/app/(app)/jobcards/lifecycle-actions.tsx`, `src/app/(app)/jobcards/page.tsx`, `src/app/(app)/jobcards/[id]/page.tsx`, `src/components/ui/{dialog,textarea,flash}.tsx`, `src/lib/money.ts` |
| S04 — Machine detail (5 tabs), mobile + desktop | `src/app/(app)/machines/[id]/page.tsx`, `src/app/(app)/machines/[id]/meter-graph.tsx`, `src/app/(app)/machines/[id]/{reading,watch,service,kit,licence,budget,qr}-actions.ts`, `src/app/(app)/machines/[id]/checklists/**`, `src/app/(app)/machines/[id]/qr/page.tsx`, `src/app/(app)/machines/[id]/{file,sale-pack,warranty-pack}.pdf/route.ts` |
| S05 — Public QR (scan) + faults triage, mobile + desktop | `src/app/(public)/m/[token]/page.tsx`, `src/app/(public)/m/[token]/actions.ts`, `src/app/(app)/faults/page.tsx`, `src/app/(app)/faults/actions.ts`, `src/app/api/public/fault/route.ts`, `src/app/api/faults/route.ts`, `src/components/fault-capture.tsx`, `src/components/offline/offline-form.tsx`, `src/lib/fuel.ts`, `src/lib/entitlements.ts` |
| S06 — Contractor portal + work request detail, mobile + desktop | `src/app/(app)/contractor/page.tsx`, `src/app/(app)/work/page.tsx`, `src/app/(app)/work/[id]/page.tsx`, `src/app/(app)/work/actions.ts`, `src/lib/work.ts`, `src/lib/contractor.ts`, `src/lib/contractor-plan.ts`, `src/components/work-request-media.tsx`, `src/app/api/work/media/route.ts` |
| S07 — Costs & reports + Diesel, mobile + desktop | `src/app/(app)/reports/page.tsx`, `src/app/(app)/reports/data.ts`, `src/app/(app)/reports/{cost,by-type,compliance,problems,fuel,budgets,utilisation,contractors}.csv/route.ts`, `src/app/(app)/reports/workbook.xlsx/route.ts`, `src/app/(app)/reports/audit-pack.pdf/route.ts`, `src/app/(app)/fuel/page.tsx`, `src/app/(app)/fuel/actions.ts`, `src/lib/fuel.ts`, `src/components/fuel-trend.tsx` |
| S08 — People + Farm settings, mobile + desktop | `src/app/(app)/team/page.tsx`, `src/app/(app)/team/actions.ts`, `src/app/(app)/team/export/route.ts`, `src/app/(app)/settings/page.tsx`, `src/app/(app)/settings/actions.ts`, `src/components/confirm-form.tsx`, `supabase/migrations/0204_settings.sql` |
| S09 — Login + first-run onboarding, mobile + desktop | `src/app/(auth)/login/page.tsx`, `src/app/(auth)/login/login-form.tsx`, `src/app/(auth)/login/actions.ts`, `src/app/auth/callback/route.ts`, `src/app/(app)/onboarding/page.tsx`, `src/lib/auth.ts` |
| S10 — RR admin console (farms list + farm detail), desktop | `src/app/(app)/admin/layout.tsx`, `src/app/(app)/admin/farms/page.tsx`, `src/app/(app)/admin/farms/actions.ts`, `src/app/(app)/admin/farms/[id]/page.tsx`, `src/app/(app)/admin/farms/[id]/actions.ts`, `supabase/migrations/0206_admin_impersonation.sql`, `src/lib/entitlements.ts` |
| S11 — Driver/operator home (new screen), mobile | `src/lib/auth.ts` (role gates + requireRole fallback), `src/components/ui/nav.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/team/actions.ts` (invite language default) |
